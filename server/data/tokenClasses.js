import fs from 'node:fs';

// Curated token categories (what a token is and who sets its price); edited by hand in tokenClasses.json, key "chainId:address"
export const TOKEN_CLASSES = new Map(Object.entries(JSON.parse(fs.readFileSync(new URL('./tokenClasses.json', import.meta.url), 'utf8'))));
