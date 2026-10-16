import type { BeliefState } from "./ast.js";

// Five base-36 characters encode flight, hotel, unknown, budget and direct
// probabilities in that order. Each value is rounded to 1/35 increments.
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const intents = ["book_flight", "book_hotel", "unknown"] as const;
const markers = { book_flight: "F", book_hotel: "H", unknown: "U" } as const;
type Intent = typeof intents[number];
export type ChatCodeVariant = "base36_5" | "dominant_4" | "dominant_5" | "dominant_6" | "labeled_7" | "labeled_8" | "labeled_9" | "labeled_10";

function digit(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("belief probabilities must be between 0 and 1");
  }
  return alphabet[Math.round(value * 35)];
}

export function encodeChatBeliefs(state: BeliefState): string {
  const intent = state.intent;
  const user = state.user;
  if (!intent || !user) throw new Error("chat beliefs are missing");
  return digit(intent.book_flight) + digit(intent.book_hotel) + digit(intent.unknown) +
    digit(user.budget_sensitive) + digit(user.prefers_direct);
}

export function decodeChatBeliefs(code: string): BeliefState {
  if (!/^[0-9a-z]{5}$/.test(code)) throw new Error("chat belief code must have five base-36 characters");
  const values = [...code].map((char) => alphabet.indexOf(char) / 35);
  const intentTotal = values[0] + values[1] + values[2];
  if (intentTotal === 0) throw new Error("chat belief code has no intent probability");
  return {
    intent: {
      book_flight: values[0] / intentTotal,
      book_hotel: values[1] / intentTotal,
      unknown: values[2] / intentTotal,
    },
    user: { budget_sensitive: values[3], prefers_direct: values[4] },
  };
}

function topIntent(state: BeliefState): Intent {
  return intents.reduce((top, intent) => state.intent[intent] > state.intent[top] ? intent : top);
}

function intentFromMarker(marker: string): Intent {
  const intent = intents.find((name) => markers[name] === marker);
  if (!intent) throw new Error(`invalid intent marker ${marker}`);
  return intent;
}

function probability(char: string): number {
  const index = alphabet.indexOf(char);
  if (index < 0) throw new Error(`invalid probability character ${char}`);
  return index / 35;
}

export function encodeChatCode(state: BeliefState, variant: ChatCodeVariant): string {
  if (variant === "base36_5") return encodeChatBeliefs(state);
  const intent = topIntent(state);
  const marker = markers[intent];
  const budget = digit(state.user.budget_sensitive);
  const direct = digit(state.user.prefers_direct);
  if (variant === "dominant_4") return marker + digit(state.intent[intent]) + budget + direct;
  if (variant === "dominant_5") {
    const firstOther = intents.find((name) => name !== intent)!;
    return marker + digit(state.intent[intent]) + digit(state.intent[firstOther]) + budget + direct;
  }
  const full = encodeChatBeliefs(state);
  if (variant === "dominant_6") return marker + full;
  if (variant === "labeled_7") return `F${full[0]}H${full[1]}${full[2]}${full[3]}${full[4]}`;
  if (variant === "labeled_8") return `F${full[0]}H${full[1]}B${full[3]}D${full[4]}`;
  if (variant === "labeled_9") return `F${full[0]}H${full[1]}U${full[2]}B${full[3]}${full[4]}`;
  return `F${full[0]}H${full[1]}U${full[2]}B${full[3]}D${full[4]}`;
}

export function decodeChatCode(code: string, variant: ChatCodeVariant): BeliefState {
  if (variant === "base36_5") return decodeChatBeliefs(code);
  if (variant === "labeled_7") {
    if (!/^F[0-9a-z]H[0-9a-z]{4}$/.test(code)) throw new Error("invalid seven-character labeled chat code");
    return decodeChatBeliefs(code[1] + code[3] + code[4] + code[5] + code[6]);
  }
  if (variant === "labeled_8") {
    if (!/^F[0-9a-z]H[0-9a-z]B[0-9a-z]D[0-9a-z]$/.test(code)) {
      throw new Error("invalid compact labeled chat code");
    }
    const flight = probability(code[1]);
    const hotel = probability(code[3]);
    const unknown = Math.max(0, 1 - flight - hotel);
    const total = flight + hotel + unknown;
    return {
      intent: { book_flight: flight / total, book_hotel: hotel / total, unknown: unknown / total },
      user: { budget_sensitive: probability(code[5]), prefers_direct: probability(code[7]) },
    };
  }
  if (variant === "labeled_10") {
    if (!/^F[0-9a-z]H[0-9a-z]U[0-9a-z]B[0-9a-z]D[0-9a-z]$/.test(code)) {
      throw new Error("invalid labeled chat code");
    }
    return decodeChatBeliefs(code[1] + code[3] + code[5] + code[7] + code[9]);
  }
  if (variant === "labeled_9") {
    if (!/^F[0-9a-z]H[0-9a-z]U[0-9a-z]B[0-9a-z]{2}$/.test(code)) {
      throw new Error("invalid nine-character labeled chat code");
    }
    return decodeChatBeliefs(code[1] + code[3] + code[5] + code[7] + code[8]);
  }
  const length = variant === "dominant_4" ? 4 : variant === "dominant_5" ? 5 : 6;
  if (code.length !== length || !/^[FHU][0-9a-z]+$/.test(code)) throw new Error("invalid dominant chat code");
  const dominant = intentFromMarker(code[0]);
  if (variant === "dominant_6") return decodeChatBeliefs(code.slice(1));
  const top = probability(code[1]);
  const other = intents.filter((name) => name !== dominant);
  const firstOther = variant === "dominant_5" ? probability(code[2]) : (1 - top) / 2;
  const third = Math.max(0, 1 - top - firstOther);
  const raw = { [dominant]: top, [other[0]]: firstOther, [other[1]]: third } as Record<Intent, number>;
  // Preserve the explicit dominant label if rounding made it tie another intent.
  raw[dominant] = Math.max(raw[dominant], raw[other[0]] + 1e-9, raw[other[1]] + 1e-9);
  const total = raw.book_flight + raw.book_hotel + raw.unknown;
  return {
    intent: { book_flight: raw.book_flight / total, book_hotel: raw.book_hotel / total, unknown: raw.unknown / total },
    user: {
      budget_sensitive: probability(code[length - 2]),
      prefers_direct: probability(code[length - 1]),
    },
  };
}

export const CHAT_CODE_INSTRUCTIONS: Record<ChatCodeVariant, string> = {
  base36_5: "previous_code has five base-36 characters 0-9/a-z. They mean flight, hotel, unknown, budget, direct probabilities in that order, each digit divided by 35. Normalize the first three.",
  dominant_4: "previous_code has four characters. First F/H/U marks the most likely intent flight/hotel/unknown. Second is its probability. Third and fourth are budget and direct probabilities. The two other intents split the remaining mass equally. Probabilities are base-36 digits 0-9/a-z divided by 35.",
  dominant_5: "previous_code has five characters. First F/H/U marks the most likely intent flight/hotel/unknown. Second is its probability. Third is the probability of the first other intent in F,H,U order; the last intent gets the remaining mass. Fourth and fifth are budget and direct probabilities. Probabilities are base-36 digits 0-9/a-z divided by 35.",
  dominant_6: "previous_code has six characters. First F/H/U explicitly marks the most likely intent flight/hotel/unknown. The next five base-36 digits 0-9/a-z encode flight, hotel, unknown, budget, direct probabilities in order, each divided by 35. Normalize the three intent probabilities.",
  labeled_7: "previous_code has form F#H####, where each # is a base-36 digit 0-9/a-z divided by 35. The five digits in order encode flight, hotel, unknown, budget, direct probabilities. F and H are labels for the first two digits. Normalize the three intent probabilities.",
  labeled_8: "previous_code has form F#H#B#D#, where # is a base-36 digit 0-9/a-z divided by 35. F and H encode flight and hotel intent probabilities; unknown gets remaining probability, then normalize. B and D encode budget and direct-flight preference probabilities.",
  labeled_9: "previous_code has form F#H#U#B##, where each # is a base-36 digit 0-9/a-z divided by 35. F,H,U are labels for flight, hotel, unknown intent probabilities; normalize them. B labels the budget probability. The final digit is the direct-flight preference probability.",
  labeled_10: "previous_code has the form F#H#U#B#D#, where each # is a base-36 digit 0-9/a-z divided by 35. F,H,U encode flight, hotel, unknown intent probabilities; normalize them. B and D encode budget and direct-flight preference probabilities.",
};

export const CHAT_CODE_BASE_INSTRUCTIONS = "Maintain current beliefs for a travel-support conversation. Input JSON has previous_code and new_message; null previous_code means no prior beliefs. Return probabilities for primary booking intent book_flight, book_hotel, or unknown, summing to 1. Return independent probabilities for budget_sensitive (low price) and prefers_direct (nonstop flight). The latest explicit change overrides older statements; otherwise preferences persist. Base the result only on the supplied input.";
