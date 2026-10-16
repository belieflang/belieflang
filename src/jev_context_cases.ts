import type { ChatTurn } from "./chat_cases.js";

// Written before running the Jev context benchmark on these messages.
export const jevContextCases: Array<{ id: string; turns: ChatTurn[] }> = [
  {
    id: "tokyo_trip",
    turns: [
      { id: "c1", message: "Please find a low-cost hotel in Tokyo for my visit. I have not chosen any flights yet.", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
      { id: "c2", message: "For that hotel, a small room is fine if the nightly price stays low. Keep searching lodging near the station.", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
      { id: "c3", message: "Switch to flights to Tokyo now. I want a nonstop flight if one is available; keep the trip inexpensive.", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
      { id: "c4", message: "Please compare departure times for those flights. I still want to avoid connections and keep the fare affordable.", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
      { id: "c5", message: "I can spend more on the airfare now. Stop filtering for the lowest price, but keep the nonstop flight requirement.", intent: "book_flight", budget_sensitive: false, prefers_direct: true },
      { id: "c6", message: "Go back to hotels. Find a room near the station with a quiet workspace; the bigger travel budget still applies.", intent: "book_hotel", budget_sensitive: false, prefers_direct: true },
      { id: "c7", message: "Pause both bookings and show me train passes for travel within Japan. I have no new budget or flight preference.", intent: "unknown", budget_sensitive: false, prefers_direct: true },
      { id: "c8", message: "Actually search flights again. I can take a connection now, so stop requiring a nonstop flight. Price is still flexible.", intent: "book_flight", budget_sensitive: false, prefers_direct: false },
      { id: "c9", message: "For those flights, please return to cheaper fares; I have a strict airfare cap again. A layover remains fine.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "c10", message: "Switch back to Tokyo hotels and show budget rooms. The spending cap still applies, and I have no new view on flight stops.", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
    ],
  },
  {
    id: "oslo_trip",
    turns: [
      { id: "d1", message: "Find me a direct flight to Oslo for a work trip. I can pay for convenience, so there is no tight budget.", intent: "book_flight", budget_sensitive: false, prefers_direct: true },
      { id: "d2", message: "Keep comparing nonstop flights to Oslo with suitable arrival times. I have not changed the flexible budget.", intent: "book_flight", budget_sensitive: false, prefers_direct: true },
      { id: "d3", message: "Now look for a hotel near the Oslo office. A comfortable room matters more than the nightly rate.", intent: "book_hotel", budget_sensitive: false, prefers_direct: true },
      { id: "d4", message: "The hotel budget has been reduced. Please find an inexpensive room near the office instead.", intent: "book_hotel", budget_sensitive: true, prefers_direct: true },
      { id: "d5", message: "Return to flights. I will accept one stop to save money, so the earlier nonstop requirement is canceled.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "d6", message: "Set flights and hotels aside. I need ferry schedules for a weekend side trip, not a booking for either of those.", intent: "unknown", budget_sensitive: true, prefers_direct: false },
      { id: "d7", message: "Search hotels again. The company raised the room allowance, so you may stop prioritizing the cheapest options.", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
      { id: "d8", message: "Switch back to airfare. I need a nonstop flight after all, and the higher allowance still makes price secondary.", intent: "book_flight", budget_sensitive: false, prefers_direct: true },
      { id: "d9", message: "Compare those direct flights by arrival time. Please stay with flights; I still have no strict price cap.", intent: "book_flight", budget_sensitive: false, prefers_direct: true },
      { id: "d10", message: "Stop the booking searches for now. Please explain visa rules only; do not search for a flight or hotel. My preferences have not changed.", intent: "unknown", budget_sensitive: false, prefers_direct: true },
    ],
  },
];
