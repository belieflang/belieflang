export type TravelCase = {
  id: string;
  text: string;
  intent: "book_flight" | "book_hotel" | "unknown";
  budget_sensitive: boolean;
  prefers_direct: boolean;
};

export const travelCases: TravelCase[] = [
  { id: "flight_cheap_direct", text: "Find me a cheap nonstop flight to Berlin", intent: "book_flight", budget_sensitive: true, prefers_direct: true },
  { id: "flight_regular", text: "I need airfare from Paris to Rome next Tuesday", intent: "book_flight", budget_sensitive: false, prefers_direct: false },
  { id: "flight_connections", text: "Book a flight with a stopover in Lisbon", intent: "book_flight", budget_sensitive: false, prefers_direct: false },
  { id: "hotel_budget", text: "Find an inexpensive hotel near the station", intent: "book_hotel", budget_sensitive: true, prefers_direct: false },
  { id: "hotel_regular", text: "Reserve a room for two nights at a hotel in Madrid", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
  { id: "hotel_luxury", text: "Book a luxury suite for the weekend", intent: "book_hotel", budget_sensitive: false, prefers_direct: false },
  { id: "unknown_train", text: "What time does the train leave?", intent: "unknown", budget_sensitive: false, prefers_direct: false },
  { id: "unknown_weather", text: "Tell me tomorrow's weather in Berlin", intent: "unknown", budget_sensitive: false, prefers_direct: false },
];
