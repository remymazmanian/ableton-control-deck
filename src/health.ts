import { AbletonCommands } from "./commands.js";
import { AbletonClient } from "./ableton-client.js";

const ableton = new AbletonClient();
const result = await new AbletonCommands(ableton).status();
console.log(JSON.stringify(result, null, 2));
ableton.close();
process.exitCode = result.ok ? 0 : 1;
