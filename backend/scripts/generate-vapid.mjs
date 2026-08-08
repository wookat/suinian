// Generate a VAPID keypair for Web Push and print wrangler secret commands.
// Usage: node scripts/generate-vapid.mjs
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const raw = new Uint8Array([4, ...b64uToBytes(pubJwk.x), ...b64uToBytes(pubJwk.y)]);
console.log("VAPID_PUBLIC_KEY=" + bytesToB64u(raw));
console.log("VAPID_PRIVATE_KEY=" + privJwk.d);
console.log("\nSet them with:");
console.log("  npx wrangler secret put VAPID_PUBLIC_KEY");
console.log("  npx wrangler secret put VAPID_PRIVATE_KEY");
