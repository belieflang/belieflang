import type { ChatTurn } from "./chat_cases.js";

// Written after freezing the compact Jev delta prompt, before calling Jev on these messages.
export const jevContextHoldoutCases: Array<{ id: string; turns: ChatTurn[] }> = [
  {
    id: "rome_trip",
    turns: [
      { id: "e1", message: "Find an inexpensive flight to Rome. I am fine changing planes if that keeps the fare down.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "e2", message: "Keep comparing airfare to Rome. The cheapest reasonable ticket is still my priority, and a connection is acceptable.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "e3", message: "Plans changed: only show nonstop flights now. Price is no longer a concern, so do not filter for a low fare.", intent: "book_flight", budget_sensitive: false, prefers_direct: true },
      { id: "e4", message: "Pause flights and find a hotel near the Colosseum. I can pay for a comfortable room.", intent: "book_hotel", budget_sensitive: false, prefers_direct: true },
      { id: "e5", message: "For the hotel, switch to economy rooms. I need to keep the nightly price low after all.", intent: "book_hotel", budget_sensitive: true, prefers_direct: true },
      { id: "e6", message: "Set both bookings aside and look up bus tickets between Rome and Florence instead. The tight budget still applies.", intent: "unknown", budget_sensitive: true, prefers_direct: true },
      { id: "e7", message: "Go back to flights to Rome. A layover is okay again, and I still want to keep the fare low.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "e8", message: "Continue the flight search, but remove the price ceiling. I can spend more; a stop is still fine.", intent: "book_flight", budget_sensitive: false, prefers_direct: false },
      { id: "e9", message: "Switch to hotels again. Find a comfortable room; I am still flexible about price.", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
      { id: "e10", message: "Actually, show the cheapest suitable hotel rooms. The room budget is tight again.", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
    ],
  },
  {
    id: "vancouver_trip",
    turns: [
      { id: "f1", message: "Please book a hotel in Vancouver near the waterfront. I can afford a premium room; no price cap.", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
      { id: "f2", message: "Keep searching those waterfront hotels. A good view matters more to me than saving money.", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
      { id: "f3", message: "Now find flights to Vancouver. I need a nonstop flight and would like to keep the airfare low.", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
      { id: "f4", message: "Compare departure times for the direct flights. Please stay within the airfare limit.", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
      { id: "f5", message: "I can take a connection now, and my employer will cover the higher fare. Stop treating cost as a constraint.", intent: "book_flight", budget_sensitive: false, prefers_direct: false },
      { id: "f6", message: "Continue with flights, including one-stop itineraries. I still have no strict spending limit.", intent: "book_flight", budget_sensitive: false, prefers_direct: false },
      { id: "f7", message: "For this step, find train schedules instead of booking a flight or hotel. No preference has changed.", intent: "unknown", budget_sensitive: false, prefers_direct: false },
      { id: "f8", message: "Return to hotels. A simple low-cost room is best now; please show the cheaper options.", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
      { id: "f9", message: "Switch to airfare again. I now insist on a nonstop flight; the limited budget still matters.", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
      { id: "f10", message: "Look for a hotel instead. My budget restriction has been lifted, so pick a nicer room. I have not changed my flight preference.", intent: "book_hotel", budget_sensitive: false, prefers_direct: true },
    ],
  },
];
