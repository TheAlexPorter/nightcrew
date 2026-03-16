/**
 * Setup helper — run this once to find your Trello list IDs.
 * Usage: bun run setup
 */

const TRELLO_API_KEY = process.env.TRELLO_API_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || "";
const BOARD_ID = process.argv[2];

if (!BOARD_ID) {
  console.error("Usage: TRELLO_API_KEY=xxx TRELLO_TOKEN=xxx bun run setup <boardId>");
  console.error("\nTo find your board ID: open Trello, add .json to the board URL");
  process.exit(1);
}

if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
  console.error("Set TRELLO_API_KEY and TRELLO_TOKEN environment variables");
  process.exit(1);
}

const res = await fetch(
  `https://api.trello.com/1/boards/${BOARD_ID}/lists?fields=id,name&key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
);

if (!res.ok) {
  console.error(`Trello API error: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const lists = await res.json() as { id: string; name: string }[];

console.log("\n📋 Lists on this board:\n");
for (const list of lists) {
  console.log(`  ${list.name.padEnd(30)} → "${list.id}"`);
}

console.log(`
\n✅ Copy the IDs above into your projects.json like this:

  "queueListId":       "<id of your Queue column>",
  "inProgressListId":  "<id of your In Progress column>",
  "humanReviewListId": "<id of your Human Review column>",
`);
