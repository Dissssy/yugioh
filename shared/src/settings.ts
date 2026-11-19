/** An account's preferences, kept on the server so they follow the account to any browser. */
export interface UserSettings {
  /** Whether the opponent's cards on the field face them, as across a real table, or face you. */
  opponentCards: 'faceThem' | 'faceYou';
}

/** What every setting is until the account changes it. Guests always get these. */
export const defaultSettings: UserSettings = { opponentCards: 'faceThem' };
