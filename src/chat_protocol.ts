import type { BeliefSnapshot } from "./runtime.js";

export const CHAT_INSTRUCTIONS = "Maintain beliefs for a travel-support conversation. Input JSON contains either messages (the full conversation in order) or previous_beliefs plus new_message (a compact snapshot and the latest turn). Return current probabilities for primary booking intent: book_flight, book_hotel, or unknown if the current request is about neither. The intent probabilities should sum to 1. Return independent probabilities for budget_sensitive (a preference for a low price) and prefers_direct (a preference for a nonstop flight). The latest explicit change overrides older statements. Otherwise preferences persist. Base the result only on the supplied input.";

export function snapshotTurnInput(snapshot: BeliefSnapshot, message: string): string {
  return JSON.stringify({ previous_beliefs: snapshot.beliefs, new_message: message });
}

export function fullHistoryInput(messages: string[]): string {
  return JSON.stringify({ messages });
}
