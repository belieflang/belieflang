import { domains, labelFor, type Conversation } from "./multidomain_cases.js";

// Synthetic follow-up evaluation authored after inspecting v1 errors, frozen before live calls.
// Separate from the original scripts, but not independently authored or blinded.
export const holdoutConversations: Conversation[] = [
  { id: "holdout_travel_bergen", domain: "travel", turns: [
    ["Arrange a room in Bergen for a research visit. The price is unrestricted. For any flights we discuss later, I require nonstop travel.", "B01"],
    ["The accommodation reimbursement has shrunk. Please favour inexpensive rooms from this point on.", "B11"],
    ["Move on to finding the airline ticket to Bergen. The cheap-price and nonstop requirements both apply.", "A11"],
    ["Suspend the travel search and explain jet lag generally. Also, the spending restriction has been lifted for future bookings.", "U01"],
    ["Return to selecting an airline ticket. A connection would be acceptable now.", "A00"],
    ["The fare ceiling has been reinstated. Minimise what I spend.", "A10"],
  ] },
  { id: "holdout_shopping_fieldwork", domain: "shopping", turns: [
    ["Choose a phone for fieldwork. I need an inexpensive option and secondhand devices are acceptable.", "A10"],
    ["My employer now insists on sealed, unused equipment. Apply that requirement to this purchase.", "A11"],
    ["Set the purchase aside: explain DNS resolution. I want a networking lesson, without product recommendations.", "U11"],
    ["Choose a laptop instead of a phone. The existing spending and condition requirements still apply.", "B11"],
    ["Funding is now unlimited, so remove the emphasis on cheap pricing.", "B01"],
    ["The procurement officer approved secondhand equipment. Previously owned machines are acceptable.", "B00"],
  ] },
  { id: "holdout_support_inventory", domain: "support", turns: [
    ["Investigate a slow inventory database query. It is routine priority, and a service restart is forbidden.", "B00"],
    ["Customers can no longer submit orders. Treat the investigation as urgent from now on.", "B10"],
    ["Take a break from diagnosis and define idempotence for a training slide. This is a conceptual question.", "U10"],
    ["Investigate the HTTP inventory endpoint instead. The outage is still urgent, and operations now permits restarting the service.", "A11"],
    ["Customer impact has ended. Downgrade this investigation to routine priority.", "A01"],
    ["A new maintenance restriction prohibits any restart. Continue investigating under that restriction.", "A00"],
  ] },
  { id: "holdout_planning_museum", domain: "planning", turns: [
    ["Schedule the museum committee meeting. The date is fixed, and I must handle the arrangements myself without delegation.", "A00"],
    ["The date may now move, and a colleague is authorised to handle the arrangements.", "A11"],
    ["Switch to preparing the attendance report. The deadline remains movable and colleagues may contribute.", "B11"],
    ["The contents have become confidential. I must do all the work personally; withdraw permission to delegate.", "B10"],
    ["Just explain operating margin as a general accounting concept. No meeting or report work is requested in this turn.", "U10"],
    ["Resume preparing the attendance report. It now has an immovable submission cutoff, and I still need to work alone.", "B00"],
  ] },
  { id: "holdout_writing_volunteers", domain: "writing", turns: [
    ["Compose a direct message to the volunteers. Give a detailed explanation and use a relaxed, informal voice.", "B00"],
    ["Make this brief and adopt a formal voice for future drafts.", "B11"],
    ["Change the format to an email to the coordinator, retaining the current length and tone preferences.", "A11"],
    ["The coordinator prefers conversational language. Drop the formality requirement.", "A10"],
    ["For future drafts, longer explanations are welcome again. Right now, only explain the purpose of a semicolon; do not compose a message or email.", "U00"],
    ["Compose a chat message to the committee in a formal voice. The longer length preference remains.", "B01"],
  ] },
];

export function validateHoldout() {
  if (holdoutConversations.length !== 5 || new Set(holdoutConversations.map(c => c.id)).size !== 5 ||
      new Set(holdoutConversations.map(c => c.domain)).size !== 5) throw new Error("expected one holdout conversation per domain");
  for (const c of holdoutConversations) {
    if (!Object.hasOwn(domains, c.domain) || c.turns.length !== 6) throw new Error(`invalid holdout conversation ${c.id}`);
    for (const [i, [message, code]] of c.turns.entries()) {
      if (!message.trim() || !/^[ABU][01]{2}$/.test(code)) throw new Error(`invalid holdout turn ${c.id}:${i + 1}`);
      const label = labelFor(c, i);
      if (!domains[c.domain].intents.includes(label.intent)) throw new Error(`invalid holdout label ${c.id}:${i + 1}`);
    }
  }
  return { conversations: 5, turns: 30, domains: holdoutConversations.map(c => c.domain) };
}
