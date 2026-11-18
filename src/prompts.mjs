import { expand } from "@inquirer/prompts";

// Asks y/n/a before each live edit. Answering "a" approves that item and every
// later one without asking again. Enter alone means "no", so a stray keypress
// can't change a live item.
export function makeApprover() {
  let all = false;
  return async function approve(message) {
    if (all) return true;
    const answer = await expand({
      message,
      default: "n",
      choices: [
        { key: "y", name: "Yes, edit this item", value: "y" },
        { key: "n", name: "No, skip this item", value: "n" },
        { key: "a", name: "All: edit this and every remaining item without asking", value: "a" },
      ],
    });
    if (answer === "a") all = true;
    return answer !== "n";
  };
}

export const APPROVER_HELP = "You'll be asked before each edit: y = edit this item, n = skip it, a = edit it and all the rest without asking.";
