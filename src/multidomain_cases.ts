// Fixture text and labels preserved from the user-supplied multidomain benchmark archive.
export type Domain = {
  intents: [string, string, string];
  flags: [string, string];
  descriptions: [string, string, string];
  flagDescriptions: [string, string];
};
export type Conversation = { id: string; domain: string; turns: [string, string][] };
export type Prediction = { intent: string } & Record<string, string | boolean>;

// Hand-authored, deterministic, labeled test conversations. No model-generated labels.
// A/B/U = first/second/unknown intent; trailing digits = current binary preferences.
export const domains: Record<string, Domain> = {
  travel: {
    intents: ["book_flight", "book_hotel", "unknown"],
    flags: ["budget_sensitive", "prefers_direct"],
    descriptions: ["find or book a flight", "find or book a hotel", "another request"],
    flagDescriptions: ["the traveler currently prioritizes low prices", "the traveler currently prefers nonstop flights"],
  },
  shopping: {
    intents: ["shop_phone", "shop_laptop", "unknown"],
    flags: ["budget_sensitive", "prefers_new"],
    descriptions: ["choose or buy a phone", "choose or buy a laptop", "another request"],
    flagDescriptions: ["the buyer currently prioritizes low prices", "the buyer currently requires a new, not used or refurbished, device"],
  },
  support: {
    intents: ["debug_api", "debug_database", "unknown"],
    flags: ["urgent", "allow_restart"],
    descriptions: ["troubleshoot an API/service", "troubleshoot a database/query", "another request"],
    flagDescriptions: ["the incident currently requires urgent handling", "the user currently permits a service restart as a remedial action"],
  },
  planning: {
    intents: ["schedule_meeting", "prepare_report", "unknown"],
    flags: ["deadline_flexible", "delegate_ok"],
    descriptions: ["schedule or reschedule a meeting", "prepare or revise a report", "another request"],
    flagDescriptions: ["the deadline can currently move", "the user currently permits delegating work to teammates"],
  },
  writing: {
    intents: ["draft_email", "draft_message", "unknown"],
    flags: ["concise", "formal"],
    descriptions: ["draft an email", "draft a chat/direct message", "another request"],
    flagDescriptions: ["the user currently prefers concise writing", "the user currently prefers formal tone"],
  },
};

export const conversations: Conversation[] = [
  {
    id: "travel_milan", domain: "travel", turns: [
      ["I need a flight from Recife to Milan for a client workshop. Keep the price low and search only nonstop services for now.", "A11"],
      ["The workshop starts Monday afternoon, so a Sunday arrival should give me time to adjust. Keep looking at airfare.", "A11"],
      ["Can you check baggage allowances? I'll bring a sample kit; I don't want to change our earlier flight criteria.", "A11"],
      ["Let's sort out a hotel near the venue instead. This isn't approval to spend more; I still have a tight budget.", "B11"],
      ["Wi-Fi and a quiet desk matter for the hotel. Breakfast is optional, and I can use public transport.", "B11"],
      ["Back to flights: I learned there are no convenient nonstop departures, so connecting itineraries are acceptable now.", "A10"],
      ["One connection in Paris is fine. Compare ticket prices and keep the baggage allowance in mind.", "A10"],
      ["Our finance department approved a bigger travel allowance. Don't optimize for price anymore; I'd rather have comfortable flights.", "A00"],
      ["Actually, could you find a hotel again? The meeting moved across town, and I need accommodation near its new address.", "B00"],
      ["Don't search yet: just explain the difference between CET and CEST for this trip; leave the saved travel preferences alone.", "U00"],
    ],
  },
  {
    id: "travel_osaka", domain: "travel", turns: [
      ["I'm arranging a hotel for a week in Osaka. Work covers the bill, so cost isn't a concern. I don't care about nonstop flights.", "B00"],
      ["Please narrow the hotels to somewhere near Umeda with an early breakfast. This is still a lodging request.", "B00"],
      ["Switch to flights from Rio to Kansai. I'd prefer a nonstop itinerary if one exists, regardless of price.", "A01"],
      ["Tell me which airports and airlines to consider when booking that flight. The nonstop requirement still matters.", "A01"],
      ["My travel budget was cut unexpectedly: low price is now a priority. Keep searching for flights, with nonstop preferred.", "A11"],
      ["I can now tolerate a layover. Remove the nonstop restriction; I'd rather reduce the airfare.", "A10"],
      ["One more change: please find a hotel in Kyoto instead of searching for tickets. The budget restriction applies there too.", "B10"],
      ["Compare simple rooms near the train station. I'd rather save money than get a gym or a large suite.", "B10"],
      ["Forget the price limit; the conference organizer is paying for lodging now. Please stay on hotels.", "B00"],
      ["For now, just translate the Japanese station name I pasted into English. I'm not asking to book anything in this turn.", "U00"],
    ],
  },
  {
    id: "shopping_cameras", domain: "shopping", turns: [
      ["I want to buy a phone with a great camera. Budget is strict and it must be factory-new, not secondhand.", "A11"],
      ["Battery life and daylight photos are important too. Keep comparing phones, not computers.", "A11"],
      ["Which phone models get software updates for the longest period? Remember the constraints from before.", "A11"],
      ["Actually I need a laptop for photo editing first. New only, and keep the modest budget.", "B11"],
      ["A color-accurate screen matters on the laptop, but I can use external storage. Compare portable models.", "B11"],
      ["Refurbished devices with warranties are okay after all. Stop requiring brand-new hardware; stay on laptops.", "B10"],
      ["I've set aside additional cash, so don't prioritize a low sticker price anymore. Continue the laptop shortlist.", "B00"],
      ["Switch back to the phone purchase. I'd like to compare telephoto lenses and video stabilization.", "A00"],
      ["New only again: I changed my mind about refurbished phones. Other preferences stay as discussed.", "A01"],
      ["Please explain what OLED burn-in means, not a purchase recommendation. Don't revise my buying preferences.", "U01"],
    ],
  },
  {
    id: "shopping_student", domain: "shopping", turns: [
      ["Help me select a laptop for university. I have a small budget and I'm fine buying used if it works.", "B10"],
      ["I need Linux support and 16GB RAM on the laptop. The used-device option is still acceptable.", "B10"],
      ["Maybe I should replace my phone instead. Switch to phones while keeping the price ceiling.", "A10"],
      ["Camera quality doesn't matter much for the phone; I mainly care about reliability and security updates.", "A10"],
      ["My scholarship reimburses only newly purchased devices. They must be new from this point onward.", "A11"],
      ["Return to choosing a laptop, now with the new-device condition and the same tight budget.", "B11"],
      ["The grant was increased, so a higher-priced laptop is fine; I still need a new model.", "B01"],
      ["Find a compact laptop with good keyboard travel. No other preferences have changed.", "B01"],
      ["The grant office has approved certified refurbished machines, so used is acceptable again.", "B00"],
      ["What's the difference between ARM and x86? I need an explanation, not shopping suggestions now.", "U00"],
    ],
  },
  {
    id: "support_auth", domain: "support", turns: [
      ["Our login API is returning 503s in production. This is urgent, and restarting the service is permitted if needed.", "A11"],
      ["The problem seems limited to requests carrying older session tokens. Focus on the API incident.", "A11"],
      ["We're now seeing database connection timeouts too. Investigate the database layer first, as part of this outage.", "B11"],
      ["Check connection pool exhaustion and transaction duration. This is still high priority.", "B11"],
      ["Operations forbids restarts until the root cause is known. Do not restart anything from now on.", "B10"],
      ["The dashboard shows replica lag but the API errors continue. Switch back to debugging the API.", "A10"],
      ["Traffic has recovered, so it is no longer an emergency. Continue the API investigation in normal priority.", "A00"],
      ["I'm reviewing the indexes now; please diagnose the slow query rather than the API endpoint.", "B00"],
      ["Ops approved a controlled restart again. You can restart the affected service if diagnosis calls for it.", "B01"],
      ["Just write an incident postmortem outline for the team; no troubleshooting request in this turn.", "U01"],
    ],
  },
  {
    id: "support_billing", domain: "support", turns: [
      ["An API endpoint is sporadically timing out in staging. It's not urgent, and we must not restart it.", "A00"],
      ["Inspect the HTTP request logs and potential retry storms. Keep looking at the endpoint itself.", "A00"],
      ["We discovered a deadlock in the payments database. Shift the investigation to database queries.", "B00"],
      ["Analyze lock contention and isolation levels. We still cannot restart services.", "B00"],
      ["Payment processing is now failing for customers. Escalate to urgent incident handling immediately.", "B10"],
      ["Operations has given permission to restart the database service if that's the safest recovery option.", "B11"],
      ["The locks are clear, but the API still returns stale payment status. Debug the API instead.", "A11"],
      ["The incident is resolved. We can investigate the API at normal priority and preserve the restart permission.", "A01"],
      ["Check the query planner again because an unrelated reporting query is exceptionally slow.", "B01"],
      ["Can you explain how optimistic locking works generally? Don't treat this as a live debugging task.", "U01"],
    ],
  },
  {
    id: "planning_product", domain: "planning", turns: [
      ["Arrange a meeting with the design team for Monday. Timing can move if needed, and I can delegate the setup.", "A11"],
      ["Check calendars and suggest a 30-minute slot. I don't need to personally send all invites.", "A11"],
      ["Switch to writing our quarterly product report. The deadline remains flexible and others can help.", "B11"],
      ["Include launch metrics, reliability incidents, and customer feedback in the report.", "B11"],
      ["Legal now requires the report by 5 PM Friday, no extensions. Finish that work on a fixed deadline.", "B01"],
      ["I need to write this confidential report myself. Stop delegating any part of it.", "B00"],
      ["Actually reschedule the roadmap meeting to Thursday. Keep the strict timing and don't delegate.", "A00"],
      ["The VP can accept a later meeting if calendars are crowded; the scheduling deadline is flexible again.", "A10"],
      ["Our coordinator is allowed to handle the invitations after all. Delegate scheduling if useful.", "A11"],
      ["Please define the difference between OKRs and KPIs. No scheduling or reporting action now.", "U11"],
    ],
  },
  {
    id: "planning_finance", domain: "planning", turns: [
      ["Prepare a monthly finance report. The audit deadline is firm, and the numbers are confidential: no delegation.", "B00"],
      ["Include expense variance and the latest revenue breakdown in the report.", "B00"],
      ["Set up a review meeting with the finance lead. Keep the deadline fixed and invitations in my control.", "A00"],
      ["The lead is away on Tuesday, so find a Wednesday time slot for the meeting.", "A00"],
      ["The audit was postponed and the review can move as needed. Dates are flexible now.", "A10"],
      ["I can ask my assistant to book that meeting, so delegation is allowed.", "A11"],
      ["Return to the report. We need a revised cash forecast, and teammates can prepare supporting tables.", "B11"],
      ["The board reinstated the Friday cutoff. The report cannot be late, even if we delegate sections.", "B01"],
      ["The assistant is off the project, so I'll do this myself. No more delegation.", "B00"],
      ["Explain accrual accounting in two paragraphs. This turn isn't asking you to change the report.", "U00"],
    ],
  },
  {
    id: "writing_client", domain: "writing", turns: [
      ["Draft an email to our client about a delayed delivery. Keep it short and professional, with a formal tone.", "A11"],
      ["Mention the updated timeline without making promises about a specific day. This is still the client email.", "A11"],
      ["Now write a Slack message to our internal team about the delay. Keep it concise and formal for now.", "B11"],
      ["Include a request for a new estimate and a reminder about the incident ticket.", "B11"],
      ["The Slack channel is casual; make the tone informal from here on.", "B10"],
      ["Actually provide a detailed explanation rather than a short note. The brevity preference is gone.", "B00"],
      ["Switch back to the client email, and include more context about the mitigation plan.", "A00"],
      ["For the external email, we should use a formal tone again. Detail level can remain high.", "A01"],
      ["The client asked for just two sentences. Make future writing concise again.", "A11"],
      ["Please define the term SLA. I'm not asking for an email or message draft right now.", "U11"],
    ],
  },
  {
    id: "writing_recruiter", domain: "writing", turns: [
      ["Write a short, informal chat message to a recruiter thanking them for reaching out.", "B10"],
      ["Mention that I'm interested in backend architecture roles. Keep it a chat message.", "B10"],
      ["I need an email to the hiring manager instead. Preserve the brief, conversational tone for now.", "A10"],
      ["Explain why I enjoyed the technical interview without listing every detail in that email.", "A10"],
      ["Actually this is going to the CTO. Make the writing formal moving forward.", "A11"],
      ["Add fuller technical detail about the project; the response can be longer now.", "A01"],
      ["Write a Teams message to the recruiter about next steps, keeping the formal and detailed style.", "B01"],
      ["They prefer a relaxed tone on Teams, so switch to informal language.", "B00"],
      ["Make the Teams reply one sentence only. The concise preference is back.", "B10"],
      ["What does 'notice period' mean in job offers? Just explain; don't draft anything.", "U10"],
    ],
  },
];

export function labelFor(conversation: Conversation, index: number): Prediction {
  const domain = domains[conversation.domain];
  const code = conversation.turns[index][1];
  return {
    intent: domain.intents[({ A: 0, B: 1, U: 2 } as Record<string, number>)[code[0]]],
    [domain.flags[0]]: code[1] === "1",
    [domain.flags[1]]: code[2] === "1",
  };
}

export function validateFixtures(cases: Conversation[] = conversations, definitions: Record<string, Domain> = domains) {
  if (Object.keys(definitions).length !== 5) throw new Error("expected exactly 5 domains");
  for (const [name, d] of Object.entries(definitions)) {
    if (d.intents.length !== 3 || d.flags.length !== 2 ||
        new Set([...d.intents, ...d.flags]).size !== 5 ||
        d.descriptions.length !== 3 || d.flagDescriptions.length !== 2) {
      throw new Error(`invalid domain ${name}`);
    }
  }
  if (cases.length !== 10) throw new Error("expected exactly 10 conversations");
  const ids = new Set();
  const countByDomain = new Map();
  for (const c of cases) {
    if (!c.id.trim() || ids.has(c.id)) throw new Error(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (!Object.hasOwn(definitions, c.domain) || c.turns.length !== 10) throw new Error(`invalid conversation ${c.id}`);
    countByDomain.set(c.domain, (countByDomain.get(c.domain) ?? 0) + 1);
    c.turns.forEach(([message, code], i) => {
      if (!message.trim() || !/^[ABU][01]{2}$/.test(code)) throw new Error(`invalid turn ${c.id}:${i + 1}`);
      if (!domainLabelValid(labelFor(c, i), definitions[c.domain])) throw new Error(`invalid label ${c.id}:${i + 1}`);
    });
  }
  if ([...countByDomain.values()].some(n => n !== 2) || countByDomain.size !== 5) {
    throw new Error("expected 2 conversations in each of 5 domains");
  }
  return { conversations: cases.length, turns: cases.reduce((n, c) => n + c.turns.length, 0), domains: [...countByDomain.keys()] };
}

function domainLabelValid(label: Prediction, domain: Domain) {
  return domain.intents.includes(label.intent) && domain.flags.every(f => typeof label[f] === "boolean");
}
