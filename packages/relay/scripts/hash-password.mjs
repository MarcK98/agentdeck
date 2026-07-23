// Generate a scrypt password hash for AUTH_USERS (relay email/password login).
//
//   node packages/relay/scripts/hash-password.mjs "my-password"
//
// Prints:  scrypt$<saltHex>$<hashHex>
// Put it in the relay's AUTH_USERS env as JSON, e.g.
//   AUTH_USERS={"marc@agentdeck.ai":"scrypt$ab12…$cd34…"}
// and set AUTH_JWT_SECRET to a long random string (the token signing key).
import { scryptSync, randomBytes } from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error('usage: node scripts/hash-password.mjs "<password>"');
  process.exit(1);
}
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32);
console.log(`scrypt$${salt.toString("hex")}$${hash.toString("hex")}`);
