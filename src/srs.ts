/**
 * SuperMemo-2 (SM-2) Spaced Repetition Algorithm in TypeScript
 */

export interface SM2Result {
  repetition: number;
  interval: number;
  easeFactor: number;
  nextReview: string; // ISO 8601 string
}

/**
 * Calculates next SM-2 interval and ease factor based on rating.
 * Rating:
 *  1: Again / Forgot (Quality 1)
 *  2: Hard (Quality 3)
 *  3: Good (Quality 4)
 *  4: Easy (Quality 5)
 */
export function calculateSM2(
  rating: number,
  repetition: number,
  interval: number,
  easeFactor: number
): SM2Result {
  let quality: number;
  if (rating === 1) quality = 1;
  else if (rating === 2) quality = 3;
  else if (rating === 3) quality = 4;
  else if (rating === 4) quality = 5;
  else quality = 3;

  let newRepetition: number;
  let newInterval: number;
  let newEaseFactor: number;

  if (quality >= 3) {
    if (repetition === 0) {
      newInterval = 1;
    } else if (repetition === 1) {
      newInterval = 6;
    } else {
      newInterval = Math.round(interval * easeFactor);
    }
    newRepetition = repetition + 1;
  } else {
    newRepetition = 0;
    newInterval = 1;
  }

  // Update Ease Factor
  newEaseFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (newEaseFactor < 1.3) {
    newEaseFactor = 1.3;
  }
  newEaseFactor = Math.round(newEaseFactor * 100) / 100;

  const now = new Date();
  const nextDate = new Date(now.getTime() + newInterval * 24 * 60 * 60 * 1000);

  return {
    repetition: newRepetition,
    interval: newInterval,
    easeFactor: newEaseFactor,
    nextReview: nextDate.toISOString(),
  };
}
