import { get } from '@vercel/edge-config';
import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const config = {
    runtime: "edge",
};

const redis = Redis.fromEnv();

// Log request information for debugging
function logRequest(request: NextRequest): void {
    console.log(`Request Method: ${request.method}`);
    console.log(`Request URL: ${request.url}`);
    console.log(`Request Headers:`, Object.fromEntries(request.headers.entries()));
    console.log("---");
}


// Get random API key from Vercel Edge Config, prioritizing healthy keys
async function getRandomAPIKey(apiKeys: string[]): Promise<string> {
    if (apiKeys.length === 0) {
        console.log(JSON.stringify({ type: "error", msg: "No API keys found in environment variable" }));
        throw new Error("No API keys found in environment variable");
    }

    const disabledKeysResults = await redis.mget(...apiKeys.map(key => `disabled:${key}`));
    const cooldownKeysResults = await redis.mget(...apiKeys.map(key => `cooldown:${key}`));

    const healthyKeys = [];
    const cooldownKeys = [];

    for (let i = 0; i < apiKeys.length; i++) {
        if (disabledKeysResults[i]) {
            console.log(JSON.stringify({ type: "key_status", key: apiKeys[i], status: "disabled" }));
            continue;
        }
        if (cooldownKeysResults[i]) {
            cooldownKeys.push(apiKeys[i]);
        } else {
            healthyKeys.push(apiKeys[i]);
        }
    }

    const availableKeys = healthyKeys.length > 0 ? healthyKeys : cooldownKeys;

    if (availableKeys.length === 0) {
        console.log(JSON.stringify({ type: "error", msg: "All API keys are temporarily disabled or in cooldown" }));
        throw new Error("All API keys are temporarily disabled or in cooldown");
    }

    const selectedKey = availableKeys[Math.floor(Math.random() * availableKeys.length)];
    return selectedKey;
}


async function logKeyAvailability(apiKeys: string[]): Promise<void> {
    const totalKeys = apiKeys.length;
    if (totalKeys === 0) {
        console.log(JSON.stringify({ type: "error", msg: "No API keys configured." }));
        return;
    }

    const disabledKeysResults = await redis.mget(...apiKeys.map(key => `disabled:${key}`));
    let availableKeys = 0;
    for (let i = 0; i < apiKeys.length; i++) {
        if (!disabledKeysResults[i]) {
            availableKeys++;
        }
    }

    const availabilityRatio = (availableKeys / totalKeys) * 100;
    console.log(JSON.stringify({ type: "key_availability", available: availableKeys, total: totalKeys, ratio: availabilityRatio }));
}

// Validate API key by checking both X-Goog-Api-Key and Authorization headers
function validateAPIKey(request: NextRequest): boolean {
    // First try X-Goog-Api-Key header (for direct Google API calls)
    let apiKey = request.headers.get("X-Goog-Api-Key");

    // If not found, try Authorization header (for OpenAI-compatible calls)
    if (!apiKey) {
        const authHeader = request.headers.get("Authorization");
        if (authHeader && authHeader.startsWith("Bearer ")) {
            apiKey = authHeader.substring(7);
        }
    }

    console.log(`API Key from header: ${apiKey}`);

    // Get expected API key from environment variable
    const expectedKey = process.env.AUTH_API_KEY;
    if (!expectedKey) {
        console.log("API Key validation: FAILED - AUTH_API_KEY environment variable not set");
        return false;
    }

    if (apiKey === expectedKey) {
        console.log("API Key validation: PASSED");
        return true;
    }

    console.log("API Key validation: FAILED");
    return false;
}

async function handleUpstreamResponse(response: Response, randomAPIKey: string, apiKeys: string[]): Promise<NextResponse> {
    // Log Google API Key status and update stats in Upstash Redis
    const pipeline = redis.pipeline();
    const statsKey = `stats:${randomAPIKey}`;

    if (response.status === 200) {
        pipeline.hincrby(statsKey, 'success', 1);
    } else if (response.status === 429) {
        pipeline.hincrby(statsKey, 'failed', 1);

        // Exponential backoff for rate-limited keys
        const backoffCountKey = `backoff_count:${randomAPIKey}`;
        const backoffCount = (await redis.get<number>(backoffCountKey)) || 0;
        const backoffDuration = Math.min(3600, 600 * Math.pow(2, backoffCount)); // Max 1 hour

        pipeline.set(`disabled:${randomAPIKey}`, "true", { ex: backoffDuration });
        pipeline.set(`cooldown:${randomAPIKey}`, "true", { ex: backoffDuration + 3600 }); // 1-hour cooldown after disable
        pipeline.incr(backoffCountKey);
        pipeline.expire(backoffCountKey, 86400); // 24-hour expiry/decay for the counter

        console.log(JSON.stringify({ type: "key_status", key: randomAPIKey, status: "disabled", reason: "rate_limit", duration: backoffDuration }));
        await logKeyAvailability(apiKeys); // Log current key availability
    }

    await pipeline.exec();

    // Disable key if failure rate is high
    const stats: { success: number; failed: number } | null = await redis.hgetall(statsKey);
    if (stats) {
        const totalRequests = (stats.success || 0) + (stats.failed || 0);
        if (totalRequests > 50 && ((stats.failed || 0) / totalRequests) > 0.3) {
            const pipeline2 = redis.pipeline();
            pipeline2.set(`disabled:${randomAPIKey}`, "true", { ex: 3600 }); // Disable for 1 hour
            pipeline2.set(`cooldown:${randomAPIKey}`, "true", { ex: 7200 }); // 1-hour cooldown after disable
            await pipeline2.exec();
            console.log(JSON.stringify({ type: "key_status", key: randomAPIKey, status: "disabled", reason: "high_failure_rate", duration: 3600 }));
            await logKeyAvailability(apiKeys); // Log current key availability
        }
    }

    // Create new response headers
    const responseHeaders = new Headers(response.headers);

    // If it's a streaming response, ensure correct Content-Type is set
    if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
        responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
        responseHeaders.set("Cache-Control", "no-cache");
        responseHeaders.set("Connection", "keep-alive");
    }

    // Remove content-encoding to prevent client-side decompression issues
    responseHeaders.delete("content-encoding");

    // Return proxy response
    return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
    });
}

async function handleRequest(request: NextRequest): Promise<NextResponse> {
    try {
        // Log request information
        logRequest(request);

        // Validate API Key
        if (!validateAPIKey(request)) {
            return new NextResponse("Unauthorized: Invalid API Key", {
                status: 401,
                headers: {
                    "Content-Type": "text/plain",
                },
            });
        }

        const apiKeysEnv = (await get<string>("GOOGLE_API_KEYS")) || "";
        const apiKeys = apiKeysEnv.split(",").map(key => key.trim()).filter(key => key !== "");
        let randomAPIKey: string;
        try {
            randomAPIKey = await getRandomAPIKey(apiKeys);
            console.log(`Using Google API Key: ${randomAPIKey.substring(0, 10)}...`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.log(`Failed to get API key: ${errorMessage}`);
            return new NextResponse("Internal Server Error: API Key configuration error", {
                status: 500,
                headers: {
                    "Content-Type": "text/plain",
                },
            });
        }

        // Build target URL
        const url = new URL(request.url);
        // Use the full pathname as the API path (since all routes come here now)
        const apiPath = url.pathname || '/';
        const targetURL = `https://generativelanguage.googleapis.com${apiPath}${url.search}`;
        console.log(`Target URL: ${targetURL}`);

        // Create new request headers
        const headers = new Headers(request.headers);
        headers.set("Host", "generativelanguage.googleapis.com");

        // Remove accept-encoding to prevent gzip compression issues
        headers.delete("accept-encoding");

        // Determine authentication method based on API path
        const isOpenAICompatible = apiPath.includes('/openai/');

        if (isOpenAICompatible) {
            // For OpenAI-compatible endpoints, use Authorization header only
            headers.set("Authorization", `Bearer ${randomAPIKey}`);
            headers.delete("X-Goog-Api-Key"); // Remove if exists
        } else {
            // For native Gemini endpoints, use X-Goog-Api-Key header only
            headers.set("X-Goog-Api-Key", randomAPIKey);
            headers.delete("Authorization"); // Remove if exists
        }

        // Log outgoing headers
        console.log(`Outgoing Headers:`, Object.fromEntries(headers.entries()));

        // Create proxy request
        const proxyRequest = new Request(targetURL, {
            method: request.method,
            headers: headers,
            body: request.body,
            // @ts-ignore - duplex is required for streaming but not in TS types yet
            duplex: 'half',
        });

        // Send request to target server
        const response = await fetch(proxyRequest);

        return await handleUpstreamResponse(response, randomAPIKey, apiKeys);

    } catch (error) {
        console.error("Proxy error:", error);
        return new NextResponse("Internal Server Error", {
            status: 500,
            headers: {
                "Content-Type": "text/plain",
            },
        });
    }
}

// Export handlers for all HTTP methods
export async function GET(request: NextRequest): Promise<NextResponse> {
    return handleRequest(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    return handleRequest(request);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
    return handleRequest(request);
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
    return handleRequest(request);
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
    return handleRequest(request);
}

export async function HEAD(request: NextRequest): Promise<NextResponse> {
    return handleRequest(request);
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
    return handleRequest(request);
}