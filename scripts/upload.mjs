import { put } from '@vercel/blob';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';

// --- Encryption Setup ---
const algorithm = 'aes-256-gcm';
const ivLength = 16; // For GCM
const salt = 'a-hardcoded-salt-for-key-derivation'; // A fixed salt is okay here for this script

// Get the API key from environment variables
const apiKey = process.env.AUTH_API_KEY;
if (!apiKey) {
    throw new Error('AUTH_API_KEY environment variable not set. Please create a .env file or set it directly.');
}

// Derive a 32-byte key from the API key. This is more robust.
const key = scryptSync(apiKey, salt, 32);

// --- Main Upload Logic ---
async function encryptAndUpload() {
    // 1. Read the file content
    const filePath = resolve(process.cwd(), 'keys-daye-all.txt');
    const fileContent = await fs.readFile(filePath);

    // 2. Encrypt the content
    const iv = randomBytes(ivLength);
    const cipher = createCipheriv(algorithm, key, iv);
    const encryptedContent = Buffer.concat([cipher.update(fileContent), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 3. Combine IV, authTag, and encrypted data for storage
    const combined = Buffer.concat([iv, authTag, encryptedContent]);

    // 4. Upload the encrypted buffer to Vercel Blob
    console.log('Uploading encrypted file to Vercel Blob...');
    const { url } = await put('keys-daye-all.txt.encrypted', combined, {
        access: 'public',
        addRandomSuffix: true,
    });

    console.log('\n✅ Encrypted file uploaded successfully!');
    console.log(`Blob URL: ${url}`);
    console.log('\nNext Step: Copy this URL and add it to your Edge Config.');
}

encryptAndUpload().catch(console.error);