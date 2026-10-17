import type { FactSchema } from "./runtime.js";

export type LongHorizonCheckpoint = {
  turn: number;
  question: string;
  field: string;
  expected: string | number | boolean;
  expectedState: Record<string, string | number | boolean>;
  critical: boolean;
};
export type LongHorizonConversation = {
  id: string;
  domain: "travel" | "planning" | "shopping" | "troubleshooting" | "task_management";
  schema: FactSchema;
  turns: string[];
  checkpoints: LongHorizonCheckpoint[];
};

const c = (turns: string[][], checkpoints: LongHorizonCheckpoint[][]): LongHorizonConversation[] =>
  turns.map((messages, i) => ({
    id: ["travel_kyoto", "travel_conference", "event_launch", "project_relocation", "shopping_camera",
      "shopping_laptop", "support_payments", "support_network", "tasks_grant", "tasks_hiring"][i],
    domain: ["travel", "travel", "planning", "planning", "shopping", "shopping", "troubleshooting",
      "troubleshooting", "task_management", "task_management"][i] as LongHorizonConversation["domain"],
    schema: {
    ...([
      { destination: "string", depart_date: "string", return_date: "string", budget_usd: "number", hotel_area: "string", excluded_stop: "string" },
      { conference: "string", venue: "string", arrival_date: "string", hotel_budget_usd: "number", traveler: "string", canceled: "boolean", hotel_name: "string" },
      { event: "string", event_date: "string", venue: "string", headcount: "number", catering_exclusion: "string", owner: "string" },
      { project: "string", move_date: "string", origin: "string", destination: "string", budget_usd: "number", vendor: "string", excluded_vendor: "string" },
      { product: "string", max_price_usd: "number", sensor: "string", excluded_brand: "string", warranty_years: "number", recipient: "string" },
      { product: "string", max_price_usd: "number", ram_gb: "number", os: "string", excluded_vendor: "string", purchase_deadline: "string" },
      { service: "string", incident_id: "string", affected_region: "string", restart_allowed: "boolean", error_rate_percent: "number", owner: "string" },
      { system: "string", site: "string", maintenance_date: "string", rollback_owner: "string", packet_loss_percent: "number", restart_allowed: "boolean" },
      { grant: "string", due_date: "string", total_usd: "number", recipient: "string", excluded_cost: "string", approver: "string" },
      { role: "string", candidate: "string", interview_date: "string", salary_usd: "number", decision_owner: "string", excluded_topic: "string" },
    ][i] as FactSchema),
    task_status: { type: "string", enum: ["active", "paused", "canceled"] },
    },
    turns: messages,
    checkpoints: checkpoints[i].filter(x => x.turn <= messages.length),
  }));

const messages = [
  [
    "I'm planning a Kyoto trip for the ceramics fair. I'll fly from Sao Paulo and need a hotel too.",
    "The fair is at Miyako Messe; please keep the hotel near the venue.",
    "I can leave on 2027-04-11 and return on 2027-04-18.",
    "My total flight budget is $1,250. Don't book anything yet.",
    "Can you remind me which dates I gave you and the budget? Also, my colleague Ana may join.",
    "Unrelated: what's the difference between a ryokan and a minshuku?",
    "Actually return on 2027-04-20 instead; departure stays the same.",
    "Avoid any itinerary with a stop in Doha. Other connections are okay.",
    "The budget can rise to $1,400 if the flight includes checked baggage.",
    "What is the revised return date and maximum flight budget?",
    "Let's pause flight searches; first find a quiet hotel around Okazaki.",
    "For the hotel, a small room is fine, but I need private bathroom.",
    "Please don't assume Ana is confirmed; she has not decided.",
    "I found the fair dates: it runs April 13 through April 16.",
    "Which neighborhood should the hotel be near, and is Ana confirmed?",
    "Resume flight planning. The Doha exclusion still stands.",
    "I now need to arrive by April 12, so move departure to April 10.",
    "Keep the $1,400 ceiling and checked-bag condition.",
    "The airline confirmed one checked bag is included.",
    "Summarize my current departure, return, budget, and excluded stop.",
  ],
  [
    "I'm Sofia Mendes, attending the Open Source Summit in Lisbon with my teammate Bruno.",
    "The venue is Centro de Congressos de Lisboa; we need a hotel nearby.",
    "I arrive on 2027-06-02 and leave June 6.",
    "Keep lodging below $180 per night.",
    "What's the venue, arrival date, and nightly limit?",
    "How do Portuguese plug types differ from US outlets?",
    "Bruno can no longer travel, so only I need a room.",
    "The hotel budget is now $210 per night, breakfast included.",
    "The conference moved its opening to June 3; keep my arrival on June 2.",
    "What's the latest nightly budget and who is traveling?",
    "Please cancel the hotel search; our office booked a room already.",
    "The booking is for me only, under the name Sofia Mendes.",
    "I still attend the summit, but don't make another hotel reservation.",
    "The office room is at Hotel Roma, near the venue.",
    "Is Bruno still traveling, and what is the hotel name?",
    "Actually the office canceled that room; resume finding a hotel.",
    "Keep the $210 nightly limit and breakfast included.",
    "My arrival shifted to June 1 because of a workshop.",
    "The summit is still in Lisbon, and I'm the sole traveler.",
    "State my current arrival date, lodging limit, and traveler count.",
  ],
  [
    "I'm organizing the Northstar product launch for our team.",
    "Set it for 2027-09-14 at the Harbor Hall venue.",
    "Expect 85 attendees, including the press.",
    "I'm Nina Patel, the event owner; please help coordinate vendors.",
    "What date, venue, and headcount should I use?",
    "Quick unrelated one: how many days are in September?",
    "We now expect 110 people; the venue date is unchanged.",
    "Do not serve peanuts because two guests have severe allergies.",
    "Harbor Hall is under renovation; move the event to Alder Pavilion.",
    "What's the current venue, headcount, and catering exclusion?",
    "The launch is postponed indefinitely; cancel vendor holds for now.",
    "Marketing chose 2027-10-05 as the new date.",
    "The new date is approved, so resume planning at Alder Pavilion.",
    "Attendance is back down to 96 after press RSVPs changed.",
    "Who owns the event, and what is the current date and headcount?",
    "The caterer confirmed a nut-free menu, but peanuts remain excluded.",
    "Alder Pavilion confirmed the October 5 reservation.",
    "Please keep vendor coordination active; it isn't canceled anymore.",
    "The operations lead Maya will handle venue access with me.",
    "Give me the final date, venue, headcount, and owner.",
  ],
  [
    "I'm coordinating the Atlas office move from the Pine Street site to Rivergate.",
    "The move date is 2027-08-21, a Saturday.",
    "Our approved relocation budget is $32,000.",
    "Northstar Movers is the vendor we're considering.",
    "What are the origin, destination, move date, and budget?",
    "Unrelated: is Rivergate a common place name?",
    "Facilities says Pine Street must be vacated by August 20, so move one day earlier.",
    "The finance cap has been reduced to $28,500.",
    "Do not use Northstar; they cannot insure the server racks.",
    "What's the revised date, cap, and excluded vendor?",
    "Pause the move planning; the lease negotiation is unresolved.",
    "The lease is signed. Resume for 2027-08-20.",
    "We can increase the budget to $30,000 for insured equipment handling.",
    "Use Cedar & Co. as the vendor; they confirmed server-rack coverage.",
    "Where are we moving from and to, and which vendor is selected?",
    "The destination entrance is on Wharf Road; destination remains Rivergate.",
    "Cedar & Co. quoted $29,400, within the approved cap.",
    "The move is active again; do not treat the earlier pause as cancellation.",
    "The building manager Luis will provide access at 7 AM.",
    "Summarize the active move date, budget cap, destination, and vendor.",
  ],
  [
    "Help me choose a mirrorless camera for wildlife photography; it is for my sister Priya.",
    "My maximum is $2,200 including the body.",
    "Fast autofocus matters more than video features.",
    "I'd like at least a 20-megapixel sensor.",
    "What is the price ceiling, sensor requirement, and recipient?",
    "How do mirrorless cameras differ from DSLRs?",
    "I can stretch the ceiling to $2,450 if a telephoto lens is bundled.",
    "Exclude Orion brand; Priya had reliability problems with it.",
    "The sensor requirement can be 24 megapixels now.",
    "What's the current ceiling, minimum sensor resolution, and excluded brand?",
    "Pause shopping until I check compatibility with her existing lenses.",
    "Her lenses use the K-mount system; compatibility is required.",
    "Resume the shortlist, and keep Orion excluded.",
    "A 2-year warranty is essential, even if the price is slightly higher within budget.",
    "Who is the camera for, and what warranty length is required?",
    "Priya already owns a compatible adapter, so native K-mount is no longer required.",
    "The $2,450 maximum includes any bundled lens and warranty.",
    "Her birthday is 2027-11-03; I need to buy before then.",
    "Do not switch to a video-first model; wildlife autofocus is still the priority.",
    "Recap the recipient, ceiling, sensor minimum, excluded brand, and warranty.",
  ],
  [
    "I need a laptop for data science classes, mainly Python and local notebooks.",
    "My hard limit is $1,350.",
    "It must have at least 32 GB RAM.",
    "I prefer Linux; Ubuntu support is important.",
    "What are my price and memory limits, and preferred OS?",
    "Unrelated: what does a GPU do?",
    "The school will reimburse up to $1,500, so the limit increases.",
    "Do not recommend Velo laptops; support has been poor.",
    "16 GB could work if the RAM is upgradeable to 32 GB later.",
    "What's the new cap, minimum acceptable RAM path, and excluded vendor?",
    "Pause buying; I need to check the department's required software.",
    "Ubuntu 24.04 is required for the course image.",
    "Resume shopping; upgradeable 16 GB is acceptable.",
    "The deadline is 2027-01-12, before classes begin.",
    "Which Ubuntu version and purchase deadline did I give you?",
    "I found that the school cap is actually $1,450, not $1,500.",
    "32 GB soldered memory is okay too; upgradeability is not mandatory.",
    "Keep Velo excluded and Ubuntu 24.04 required.",
    "A refurbished unit is acceptable if it has a 2-year warranty.",
    "Summarize the latest budget, memory requirement, OS, excluded vendor, deadline.",
  ],
  [
    "Our payment API in eu-west is failing intermittently; incident INC-4821 is open.",
    "The current error rate is about 18 percent.",
    "Do not restart production without my approval.",
    "I'm the incident owner, Jordan Lee.",
    "What incident, region, error rate, and restart rule are active?",
    "Unrelated: what is the difference between EU and eurozone?",
    "Errors have fallen to 7.5 percent after we disabled retries.",
    "You may restart the canary only; production restart is still prohibited.",
    "The affected region is now eu-central; eu-west recovered.",
    "What's the current region, error rate, and production restart permission?",
    "Pause remediation; preserve logs while security reviews the issue.",
    "Security cleared the change. Resume investigation of INC-4821.",
    "The error rate rose again to 12 percent in eu-central.",
    "A production restart is now approved if canary validation passes.",
    "Who owns the incident, and what is the latest error rate and restart condition?",
    "We found the cause in the payment token cache, not the database.",
    "The canary passed; production restart is permitted under that condition.",
    "The service is stable at 0.2 percent errors.",
    "Keep the incident open until Jordan confirms reconciliation is complete.",
    "Recap incident ID, cause, owner, error rate, and restart condition.",
  ],
  [
    "Our warehouse Wi-Fi controller at the Reno site is dropping clients; ticket NET-209 is assigned to me, Rina.",
    "Packet loss is 4 percent on the warehouse VLAN.",
    "Maintenance is scheduled for 2027-03-09 at 02:00 local time.",
    "Rollback owner is Mateo from Network Operations.",
    "Which site, ticket, maintenance date, and rollback owner?",
    "Unrelated: what does VLAN stand for?",
    "Packet loss is now 11 percent after the firmware change.",
    "Cancel the maintenance window; shipping peak starts that night.",
    "New window: 2027-03-16 at 02:00 local time.",
    "What's the current packet loss and maintenance date?",
    "We can proceed with the new window, but rollback instructions must be ready.",
    "The system is called CartLink; the controller model is AX-9.",
    "Packet loss has improved to 2.5 percent after reverting one access point.",
    "Mateo remains rollback owner; do not reassign the change.",
    "What system is affected, current loss, and who owns rollback?",
    "The site team approved a controlled restart during the March 16 window.",
    "If client drops exceed 5 percent, roll back immediately.",
    "Current loss is 1 percent; the threshold is unchanged.",
    "Resume the change plan; the earlier cancellation applied only to the old date.",
    "Summarize site, system, window, rollback owner, and restart permission.",
  ],
  [
    "I'm applying for the Horizon research grant with the climate lab.",
    "The application is due 2027-02-28.",
    "The total request is $48,000.",
    "Dr. Elise Chen will receive the grant on behalf of the lab.",
    "What grant, deadline, amount, and recipient are we tracking?",
    "Unrelated: what is a fiscal sponsor?",
    "The foundation lowered the maximum request to $42,500.",
    "Exclude indirect costs; they are not eligible under this award.",
    "The deadline moved to March 7, 2027.",
    "What's the revised deadline, cap, and excluded cost category?",
    "Pause drafting; the lab director is reviewing the project scope.",
    "The scope is approved. Resume the same Horizon application.",
    "Dr. Chen remains the recipient and principal investigator.",
    "Finance approved a request of $41,800 within the cap.",
    "Who receives the grant, and what request amount is approved?",
    "The award covers equipment and fieldwork, but indirect costs remain excluded.",
    "The application is due March 7; submit at least one day early.",
    "The approver is Omar Patel in the university research office.",
    "Do not change the request to $42,500; our approved figure is $41,800.",
    "Recap deadline, requested amount, recipient, excluded costs, approver.",
  ],
  [
    "We're hiring a senior data analyst for the Meridian team.",
    "Our finalist is candidate Leah Brooks.",
    "Her final interview is scheduled for 2027-05-19.",
    "The approved salary ceiling is $142,000.",
    "Who is the candidate, when is the interview, and what is the salary cap?",
    "Unrelated: what is the difference between an analyst and a data scientist?",
    "The hiring manager, Victor Ramos, owns the final decision.",
    "Do not ask about family status; that topic is off limits.",
    "Leah needs to move the interview to May 21, 2027.",
    "What's the new interview date, decision owner, and excluded topic?",
    "Pause the process while finance rechecks headcount.",
    "Headcount is approved. Resume the same role and finalist.",
    "The salary ceiling is now $150,000 after leveling review.",
    "The candidate confirmed May 21 at 14:00.",
    "What is the current salary limit, interview date, and decision owner?",
    "Victor remains decision owner; I coordinate scheduling only.",
    "The team calls the role Senior Analytics Partner, but the requisition is unchanged.",
    "The no-family-status rule remains in force.",
    "Leah is still the finalist; no offer has been approved yet.",
    "Summarize candidate, role, interview date, salary ceiling, decision owner, exclusion.",
  ],
];

const states = [
  [
    { destination: "Kyoto", depart_date: "2027-04-11", return_date: "2027-04-18", budget_usd: 1250, hotel_area: "Miyako Messe" },
    { destination: "Kyoto", depart_date: "2027-04-11", return_date: "2027-04-20", budget_usd: 1400, hotel_area: "Miyako Messe", excluded_stop: "Doha" },
    { destination: "Kyoto", depart_date: "2027-04-11", return_date: "2027-04-20", budget_usd: 1400, hotel_area: "Okazaki", excluded_stop: "Doha" },
    { destination: "Kyoto", depart_date: "2027-04-10", return_date: "2027-04-20", budget_usd: 1400, hotel_area: "Okazaki", excluded_stop: "Doha" },
  ],
  [
    { conference: "Open Source Summit", venue: "Centro de Congressos de Lisboa", arrival_date: "2027-06-02", hotel_budget_usd: 180, traveler: "Sofia Mendes" },
    { conference: "Open Source Summit", venue: "Centro de Congressos de Lisboa", arrival_date: "2027-06-02", hotel_budget_usd: 210, traveler: "Sofia Mendes" },
    { conference: "Open Source Summit", venue: "Centro de Congressos de Lisboa", arrival_date: "2027-06-02", hotel_budget_usd: 210, traveler: "Sofia Mendes", canceled: true, hotel_name: "Hotel Roma" },
    { conference: "Open Source Summit", venue: "Centro de Congressos de Lisboa", arrival_date: "2027-06-01", hotel_budget_usd: 210, traveler: "Sofia Mendes", canceled: false, hotel_name: "Hotel Roma" },
  ],
  [
    { event: "Northstar product launch", event_date: "2027-09-14", venue: "Harbor Hall", headcount: 85, owner: "Nina Patel" },
    { event: "Northstar product launch", event_date: "2027-09-14", venue: "Alder Pavilion", headcount: 110, catering_exclusion: "peanuts", owner: "event organizer" },
    { event: "Northstar product launch", event_date: "2027-10-05", venue: "Alder Pavilion", headcount: 96, catering_exclusion: "peanuts", owner: "event organizer" },
    { event: "Northstar product launch", event_date: "2027-10-05", venue: "Alder Pavilion", headcount: 96, catering_exclusion: "peanuts", owner: "event organizer" },
  ],
  [
    { project: "Atlas office move", move_date: "2027-08-21", origin: "Pine Street", destination: "Rivergate", budget_usd: 32000, vendor: "Northstar Movers" },
    { project: "Atlas office move", move_date: "2027-08-20", origin: "Pine Street", destination: "Rivergate", budget_usd: 28500, excluded_vendor: "Northstar Movers" },
    { project: "Atlas office move", move_date: "2027-08-20", origin: "Pine Street", destination: "Rivergate", budget_usd: 30000, vendor: "Cedar & Co.", excluded_vendor: "Northstar Movers" },
    { project: "Atlas office move", move_date: "2027-08-20", origin: "Pine Street", destination: "Rivergate", budget_usd: 30000, vendor: "Cedar & Co.", excluded_vendor: "Northstar Movers" },
  ],
  [
    { product: "mirrorless wildlife camera", max_price_usd: 2200, sensor: "20 megapixels", recipient: "Priya" },
    { product: "mirrorless wildlife camera", max_price_usd: 2450, sensor: "24 megapixels", excluded_brand: "Orion", recipient: "Priya" },
    { product: "mirrorless wildlife camera", max_price_usd: 2450, sensor: "24 megapixels", excluded_brand: "Orion", warranty_years: 2, recipient: "Priya" },
    { product: "mirrorless wildlife camera", max_price_usd: 2450, sensor: "24 megapixels", excluded_brand: "Orion", warranty_years: 2, recipient: "Priya" },
  ],
  [
    { product: "data science laptop", max_price_usd: 1350, ram_gb: 32, os: "Linux" },
    { product: "data science laptop", max_price_usd: 1500, ram_gb: 16, os: "Linux", excluded_vendor: "Velo", purchase_deadline: "none" },
    { product: "data science laptop", max_price_usd: 1500, ram_gb: 16, os: "Ubuntu 24.04", excluded_vendor: "Velo", purchase_deadline: "2027-01-12" },
    { product: "data science laptop", max_price_usd: 1450, ram_gb: 32, os: "Ubuntu 24.04", excluded_vendor: "Velo", purchase_deadline: "2027-01-12" },
  ],
  [
    { service: "payment API", incident_id: "INC-4821", affected_region: "eu-west", restart_allowed: false, error_rate_percent: 18, owner: "Jordan Lee" },
    { service: "payment API", incident_id: "INC-4821", affected_region: "eu-central", restart_allowed: false, error_rate_percent: 7.5, owner: "Jordan Lee" },
    { service: "payment API", incident_id: "INC-4821", affected_region: "eu-central", restart_allowed: true, error_rate_percent: 12, owner: "Jordan Lee" },
    { service: "payment API", incident_id: "INC-4821", affected_region: "eu-central", restart_allowed: true, error_rate_percent: 0.2, owner: "Jordan Lee" },
  ],
  [
    { system: "warehouse Wi-Fi controller", site: "Reno", maintenance_date: "2027-03-09 02:00", rollback_owner: "Mateo", packet_loss_percent: 4 },
    { system: "warehouse Wi-Fi controller", site: "Reno", maintenance_date: "2027-03-09 02:00", rollback_owner: "Mateo", packet_loss_percent: 11 },
    { system: "CartLink", site: "Reno", maintenance_date: "2027-03-16 02:00", rollback_owner: "Mateo", packet_loss_percent: 2.5 },
    { system: "CartLink", site: "Reno", maintenance_date: "2027-03-16 02:00", rollback_owner: "Mateo", packet_loss_percent: 1, restart_allowed: true },
  ],
  [
    { grant: "Horizon research grant", due_date: "2027-02-28", total_usd: 48000, recipient: "Dr. Elise Chen" },
    { grant: "Horizon research grant", due_date: "2027-03-07", total_usd: 42500, recipient: "Dr. Elise Chen", excluded_cost: "indirect costs", approver: "unknown" },
    { grant: "Horizon research grant", due_date: "2027-03-07", total_usd: 41800, recipient: "Dr. Elise Chen", excluded_cost: "indirect costs" },
    { grant: "Horizon research grant", due_date: "2027-03-07", total_usd: 41800, recipient: "Dr. Elise Chen", excluded_cost: "indirect costs", approver: "Omar Patel" },
  ],
  [
    { role: "senior data analyst", candidate: "Leah Brooks", interview_date: "2027-05-19", salary_usd: 142000 },
    { role: "senior data analyst", candidate: "Leah Brooks", interview_date: "2027-05-21", salary_usd: 142000, decision_owner: "Victor Ramos", excluded_topic: "family status" },
    { role: "senior data analyst", candidate: "Leah Brooks", interview_date: "2027-05-21", salary_usd: 150000, decision_owner: "Victor Ramos", excluded_topic: "family status" },
    { role: "Senior Analytics Partner", candidate: "Leah Brooks", interview_date: "2027-05-21", salary_usd: 150000, decision_owner: "Victor Ramos", excluded_topic: "family status" },
  ],
];

const questions = [
  ["What departure date did I first give you?", "What is the latest return date?", "Which hotel area should I use?", "Which stopover city must be excluded?"],
  ["What is the hotel nightly limit?", "Who is the sole traveler?", "Is the hotel search active or canceled?", "Is the resumed hotel search active or still canceled?"],
  ["What was the original launch headcount?", "What is the current venue?", "Who owns the event?", "What is the final event date?"],
  ["What was the original relocation budget?", "Which mover was excluded?", "Which vendor is selected now?", "What is the active move date?"],
  ["Who is the camera for?", "Which camera brand is excluded?", "What warranty length is required?", "What is the current price ceiling?"],
  ["What was the original laptop price limit?", "Which vendor must be excluded?", "Which Ubuntu version is required?", "What is the latest price cap?"],
  ["What is the incident ID?", "What is the current affected region?", "Who owns the incident?", "What is the latest error rate?"],
  ["What packet loss percentage did I originally report?", "Is the 2027-03-09 maintenance window active or canceled?", "Is the March 16 plan active?", "Is a controlled restart permitted?"],
  ["What was the original request amount?", "What cost type is excluded?", "What amount is approved?", "Who is the approver?"],
  ["Who is the finalist?", "What topic is forbidden?", "What is the current salary ceiling?", "Who owns the final decision?"],
];

const answerFields = [
  ["depart_date", "return_date", "hotel_area", "excluded_stop"],
  ["hotel_budget_usd", "traveler", "task_status", "task_status"],
  ["headcount", "venue", "owner", "event_date"],
  ["budget_usd", "excluded_vendor", "vendor", "move_date"],
  ["recipient", "excluded_brand", "warranty_years", "max_price_usd"],
  ["max_price_usd", "excluded_vendor", "os", "max_price_usd"],
  ["incident_id", "affected_region", "owner", "error_rate_percent"],
  ["packet_loss_percent", "task_status", "task_status", "restart_allowed"],
  ["total_usd", "excluded_cost", "total_usd", "approver"],
  ["candidate", "excluded_topic", "salary_usd", "decision_owner"],
];
const criticalFields = new Set(["depart_date", "return_date", "excluded_stop", "arrival_date", "hotel_budget_usd",
  "canceled", "event_date", "catering_exclusion", "budget_usd", "excluded_vendor", "max_price_usd",
  "excluded_brand", "purchase_deadline", "incident_id", "affected_region", "restart_allowed",
  "error_rate_percent", "maintenance_date", "packet_loss_percent", "due_date", "total_usd",
  "excluded_cost", "interview_date", "salary_usd", "excluded_topic", "task_status"]);

const taskStatuses = [
  ["active", "active", "active", "active"],
  ["active", "active", "canceled", "active"],
  ["active", "active", "active", "active"],
  ["active", "active", "active", "active"],
  ["active", "active", "active", "active"],
  ["active", "active", "active", "active"],
  ["active", "active", "active", "active"],
  ["active", "canceled", "active", "active"],
  ["active", "active", "active", "active"],
  ["active", "active", "active", "active"],
];
const checkpointTurns = [
  [5, 10, 15, 20], [5, 10, 15, 20], [5, 10, 15, 20], [5, 10, 15, 20], [5, 10, 15, 20],
  [5, 10, 15, 20], [5, 10, 15, 20], [5, 8, 15, 20], [5, 10, 15, 20], [5, 10, 15, 20],
];

export const longHorizonConversations: LongHorizonConversation[] = c(messages, questions.map((qs, i) => qs.map((question, j) => {
  const field = answerFields[i][j];
  const expectedState: Record<string, string | number | boolean> = {
    ...(states[i][j] as Record<string, string | number | boolean>), task_status: taskStatuses[i][j],
  };
  return { turn: checkpointTurns[i][j], question, field, expected: expectedState[field], expectedState,
    critical: criticalFields.has(field) };
}))) as LongHorizonConversation[];

export function validateLongHorizonFixtures() {
  if (longHorizonConversations.length !== 10) throw new Error("expected 10 long-horizon conversations");
  const ids = new Set<string>();
  const domains = new Set(longHorizonConversations.map(x => x.domain));
  if (domains.size !== 5) throw new Error("expected five domains");
  let turns = 0, checkpoints = 0;
  for (const conversation of longHorizonConversations) {
    if (ids.has(conversation.id) || conversation.turns.length < 20 || conversation.turns.length > 50) throw new Error(`invalid conversation ${conversation.id}`);
    ids.add(conversation.id); turns += conversation.turns.length;
    if (conversation.checkpoints.length !== 4) throw new Error(`expected four checkpoints in ${conversation.id}`);
    for (const checkpoint of conversation.checkpoints) {
      checkpoints++;
      if (!conversation.turns[checkpoint.turn - 1] || !checkpoint.question.trim() || !Object.hasOwn(conversation.schema, checkpoint.field)) throw new Error(`invalid checkpoint ${conversation.id}:${checkpoint.turn}`);
      for (const [field, value] of Object.entries(checkpoint.expectedState)) {
        const type = conversation.schema[field];
        const expectedType = typeof type === "string" ? type : type?.type;
        if (!expectedType || typeof value !== expectedType) throw new Error(`state type mismatch ${conversation.id}:${checkpoint.turn}:${field}`);
        if (typeof type !== "string" && type.enum && !type.enum.includes(value as string)) throw new Error(`invalid enum value ${conversation.id}:${checkpoint.turn}:${field}`);
      }
    }
  }
  if (turns !== 200 || checkpoints !== 40) throw new Error("fixture totals must be 200 turns and 40 checkpoints");
  return { conversations: 10, domains: 5, turns, checkpoints };
}
