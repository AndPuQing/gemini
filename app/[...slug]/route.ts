import { get } from '@vercel/edge-config';
import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { createDecipheriv, scryptSync } from 'crypto';

export const config = {
    runtime: "edge",
};

const redis = Redis.fromEnv();

// Helper function to perform mget in chunks to avoid request size limits
async function mgetInChunks(keys: string[], chunkSize: number = 500): Promise<(string | null)[]> {
    if (keys.length === 0) {
        return [];
    }
    const allResults: (string | null)[] = [];
    for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        const chunkResults = await redis.mget<(string | null)[]>(...chunk);
        allResults.push(...chunkResults);
    }
    return allResults;
}

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
        console.log("Error: No API keys found in environment variable");
        throw new Error("No API keys found in environment variable");
    }

    // Use chunking for large number of keys
    const keysToCheck = apiKeys.flatMap(key => [`disabled:${key}`, `cooldown:${key}`]);
    const results = await mgetInChunks(keysToCheck);

    const healthyKeys = [];
    const cooldownKeys = [];

    for (let i = 0; i < apiKeys.length; i++) {
        const isDisabled = results[i * 2];
        const onCooldown = results[i * 2 + 1];

        if (isDisabled) {
            continue; // Skip disabled keys
        }
        if (onCooldown) {
            cooldownKeys.push(apiKeys[i]);
        } else {
            healthyKeys.push(apiKeys[i]);
        }
    }

    const availableKeys = healthyKeys.length > 0 ? healthyKeys : cooldownKeys;

    if (availableKeys.length === 0) {
        console.log("Error: All API keys are temporarily disabled or in cooldown");
        throw new Error("All API keys are temporarily disabled or in cooldown");
    }

    const selectedKey = availableKeys[Math.floor(Math.random() * availableKeys.length)];
    return selectedKey;
}


async function logKeyAvailability(apiKeys: string[]): Promise<void> {
    const totalKeys = apiKeys.length;
    if (totalKeys === 0) {
        console.log("Key Availability: No API keys configured.");
        return;
    }

    // Use chunking for large number of keys
    const keysToCheck = apiKeys.flatMap(key => [`disabled:${key}`, `cooldown:${key}`]);
    const statusResults = await mgetInChunks(keysToCheck);

    const [
        totalRequests,
        successfulRequests,
        failedRequests
    ] = await Promise.all([
        redis.get<number>('total_requests'),
        redis.get<number>('total_successful_requests'),
        redis.get<number>('total_failed_requests')
    ]);

    let healthy = 0;
    let cooldown = 0;
    let disabled = 0;

    for (let i = 0; i < apiKeys.length; i++) {
        const isDisabled = statusResults[i * 2];
        const onCooldown = statusResults[i * 2 + 1];

        if (isDisabled) {
            disabled++;
        } else if (onCooldown) {
            cooldown++;
        } else {
            healthy++;
        }
    }

    const availableKeys = healthy + cooldown;
    const availabilityRatio = totalKeys > 0 ? (availableKeys / totalKeys) * 100 : 0;
    const successRatio = (totalRequests || 0) > 0 ? ((successfulRequests || 0) / (totalRequests || 0)) * 100 : 0;

    console.log(`Key Availability: ${availableKeys}/${totalKeys} (${availabilityRatio.toFixed(2)}%) | Healthy: ${healthy}, Cooldown: ${cooldown}, Disabled: ${disabled} | Requests: ${totalRequests || 0} (Success: ${successfulRequests || 0}, Failed: ${failedRequests || 0}, Success Ratio: ${successRatio.toFixed(2)}%)`);
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

// Decrypts the content fetched from Vercel Blob
async function decrypt(encryptedContent: ArrayBuffer): Promise<string> {
    const algorithm = 'aes-256-gcm';
    const ivLength = 16;
    const authTagLength = 16;
    const salt = 'a-hardcoded-salt-for-key-derivation'; // Must match the upload script

    const apiKey = process.env.AUTH_API_KEY;
    if (!apiKey) {
        throw new Error('AUTH_API_KEY environment variable not set for decryption.');
    }

    // Derive the key, same as in the upload script
    const key = scryptSync(apiKey, salt, 32);

    const buffer = Buffer.from(encryptedContent);
    const iv = buffer.slice(0, ivLength);
    const authTag = buffer.slice(ivLength, ivLength + authTagLength);
    const encryptedData = buffer.slice(ivLength + authTagLength);

    const decipher = createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted.toString('utf-8');
}

const API_KEYS_CACHE_KEY = 'cached_api_keys';
const API_KEYS_CACHE_TTL_SECONDS = 600; // 10 minutes

// Get API keys, using a cache to avoid frequent blob reads and decryptions
async function getApiKeys(): Promise<string[]> {
    // 1. Try to get from cache first
    const cachedKeys = await redis.get<JSON>(API_KEYS_CACHE_KEY);
    if (cachedKeys) {
        console.log("API keys cache HIT");
        return cachedKeys as unknown as string[];
    }

    console.log("API keys cache MISS");

    // 2. If cache miss, fetch from blob and decrypt
    const blobUrl = await get<string>('encryptedUrl');
    if (!blobUrl) {
        throw new Error('Could not find blob URL in Edge Config item "encryptedUrl"');
    }

    const blobResponse = await fetch(blobUrl);
    if (!blobResponse.ok) {
        throw new Error(`Failed to fetch blob: ${blobResponse.statusText}`);
    }
    const encryptedContent = await blobResponse.arrayBuffer();

    const apiKeysEnv = await decrypt(encryptedContent);
    const apiKeys = apiKeysEnv.split(/\r?\n/).map(key => key.trim()).filter(key => key !== "");

    // 3. Store the fresh keys in cache with a TTL
    if (apiKeys.length > 0) {
        // Use pipeline for atomic set and expire, though `set` with `ex` is atomic itself.
        // This is just good practice.
        const pipeline = redis.pipeline();
        pipeline.set(API_KEYS_CACHE_KEY, JSON.stringify(apiKeys), { ex: API_KEYS_CACHE_TTL_SECONDS });
        await pipeline.exec();
        console.log(`API keys cached for ${API_KEYS_CACHE_TTL_SECONDS} seconds.`);
    }

    return apiKeys;
}

async function handleUpstreamResponse(response: Response, randomAPIKey: string, apiKeys: string[]): Promise<NextResponse> {
    const pipeline = redis.pipeline();
    const statsKey = `stats:${randomAPIKey}`;
    const nowISO = new Date().toISOString();

    // Always update the last used timestamp
    pipeline.hset(statsKey, { last_used_at: nowISO });

    if (response.status === 200) {
        // We will NOT increment success count per key anymore.
        // But we will record the timestamp of the last successful request.
        pipeline.hset(statsKey, { last_success_at: nowISO });
        pipeline.incr('total_successful_requests');
    } else {
        // Any non-200 response is considered a failure
        pipeline.hincrby(statsKey, 'failed', 1);
        pipeline.incr('total_failed_requests'); // Increment global failure counter

        if (response.status === 429) {
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setUTCHours(24, 0, 0, 0);
            const secondsUntilMidnight = Math.floor((tomorrow.getTime() - now.getTime()) / 1000);

            pipeline.set(`disabled:${randomAPIKey}`, "true", { ex: secondsUntilMidnight });
            pipeline.set(`cooldown:${randomAPIKey}`, "true", { ex: secondsUntilMidnight + 300 });

            console.log(`Key ${randomAPIKey} disabled for ${secondsUntilMidnight} seconds due to rate limit.`);
            await logKeyAvailability(apiKeys);
        } else if (response.status === 400) {
            // Permanently disable the key for 400 errors
            pipeline.set(`disabled:${randomAPIKey}`, "true");
            console.log(`Key ${randomAPIKey} permanently disabled due to 400 Bad Request.`);
            await logKeyAvailability(apiKeys);
        }
    }

    await pipeline.exec();

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
        // Increment global request counter
        await redis.incr('total_requests');

        // Log request information
        logRequest(request);

        // Validate API Key
        if (!validateAPIKey(request)) {
            return new NextResponse("Unauthorized: Invalid API Key", {
                status: 401,
                headers: { "Content-Type": "text/plain" },
            });
        }

        // Get API keys from cache or, if miss, from blob
        const apiKeys = await getApiKeys();

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