export type ChatTurn = {
  id: string;
  message: string;
  intent: "book_flight" | "book_hotel" | "unknown";
  budget_sensitive: boolean;
  prefers_direct: boolean;
};

export const chatCases: Array<{ id: string; turns: ChatTurn[] }> = [
  {
    id: "lisbon_trip",
    turns: [
      { id: "a1", message: "I'm planning a trip from São Paulo to Lisbon in June. Please find me a flight. I have a fairly tight budget and would strongly prefer a nonstop option because I don't want to risk missing a connection on this trip.", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
      { id: "a2", message: "The departure can be on Tuesday or Wednesday, and I can leave in the morning or evening. Keep looking at flights for now. The price ceiling is still important, and I would still rather avoid layovers even if that limits the airline choices.", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
      { id: "a3", message: "I also have one checked bag and will need enough time to get from the airport to the city center. You can compare the airlines on those details, but please keep the cheap, direct flight goal we discussed as the main booking request.", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
      { id: "a4", message: "Let's put the flight choice on hold and find a hotel in Lisbon first. It should be close to the center so I can walk to meetings, and I still want to stay within a modest budget. We can return to airfare later.", intent: "book_hotel", budget_sensitive: true, prefers_direct: true },
      { id: "a5", message: "For the hotel, a clean private room and reliable Wi-Fi matter much more than a pool or a spa. I will stay four nights. Please continue comparing affordable lodging options near the center rather than searching for another flight right now.", intent: "book_hotel", budget_sensitive: true, prefers_direct: true },
      { id: "a6", message: "Now go back to the flight. I checked the schedule and I can accept one stop if it saves enough money, so the nonstop preference is gone. The lower fare is still important, and I need the ticket for the same Lisbon trip.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "a7", message: "Could you compare the flight options with one connection against the nonstop ones? I am willing to spend extra time traveling if it keeps the ticket price down. Please keep working on airfare, not the hotel, for this step.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "a8", message: "Switch back to the hotel search. The conference venue is near the river, so a room around there would be convenient. I still need an affordable place and I am happy with a simple room rather than a fancy property.", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
      { id: "a9", message: "My employer approved a larger lodging allowance. You can stop optimizing for the cheapest room and look for a nicer hotel with good breakfast and a quiet workspace. Focus on the hotel; the flight decision can wait.", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
      { id: "a10", message: "Please compare a few of those comfortable hotels for the four-night stay and prioritize location and quiet rooms. The higher room price is fine now, and I have no new request about flight connections or ticket prices.", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
    ],
  },
  {
    id: "conference_trip",
    turns: [
      { id: "b1", message: "I am traveling to a conference in Madrid and need a hotel near the venue. A spacious suite would be nice, and I have no tight spending limit for this booking. Please start with hotels rather than transport.", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
      { id: "b2", message: "The hotel stay will be three nights, and I would like breakfast included if possible. Quiet rooms and a desk are more important than nightlife. Continue finding lodging; I have not changed the flexible budget for the room.", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
      { id: "b3", message: "I also need a flight to Madrid, so switch to airfare now. I want a direct flight because I will be carrying presentation equipment, and the company can pay for a convenient schedule even if it costs more.", intent: "book_flight", budget_sensitive: false, prefers_direct: true },
      { id: "b4", message: "Look at morning departures for that flight and leave enough time after arrival to reach the conference venue. Keep the no-stop requirement; I would rather pay a little more than risk a connection with the equipment.", intent: "book_flight", budget_sensitive: false, prefers_direct: true },
      { id: "b5", message: "There is a new travel-spend cap from my manager. Please keep the flight inexpensive, and I can accept a connection if that brings the fare down. The direct-flight preference no longer applies, but I still need airfare to Madrid.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "b6", message: "Compare the lower-priced flight tickets, including those with a stop. I can wait a bit longer at an airport if the savings are meaningful. Do not switch back to hotels yet; I want the flight shortlist first.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
      { id: "b7", message: "Now please return to the Madrid hotel. The same company spending cap also applies to lodging, so find a reasonably priced room near the conference rather than the expensive suite we discussed earlier.", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
      { id: "b8", message: "For this room search, it is okay to give up breakfast or a larger room to stay within the cap. Being near the venue still matters because I will have early sessions each day. Please continue with hotels.", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
      { id: "b9", message: "I may take a train for one part of the journey. Could you find train ticket options instead of a flight or hotel for this step? My overall spending cap still applies, but I have no new preference about nonstop flights.", intent: "unknown", budget_sensitive: true, prefers_direct: false },
      { id: "b10", message: "Forget the train idea; I do need to fly to Madrid after all. Please find the cheapest reasonable airfare, and a stop is still acceptable. The hotel is settled for now, so the current booking request is the flight.", intent: "book_flight", budget_sensitive: true, prefers_direct: false },
    ],
  },
];
