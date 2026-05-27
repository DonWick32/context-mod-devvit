declare module 'vader-sentiment' {
  export type VaderScores = {
    neg: number;
    neu: number;
    pos: number;
    compound: number;
  };

  export class SentimentIntensityAnalyzer {
    static polarity_scores(value: string): VaderScores;
  }
}
