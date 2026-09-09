export const RATED_LEVELS = ["stable", "caution", "risky"];

export interface StackRiskCounts {
  stable: number;
  caution: number;
  risky: number;
  withheld: number;
  not_found: number;
}

export interface StackGrade {
  grade: string;
  label: string;
  description: string;
  denominator: string;
}

export function isRated(level: unknown): boolean {
  return RATED_LEVELS.indexOf(level as string) >= 0;
}

export function gradeForStack(counts: StackRiskCounts, servicesEntered: number): StackGrade {
  var found = counts.stable + counts.caution + counts.risky + counts.withheld;
  if (found === 0) {
    return { grade: "?", label: "Unknown", description: "None of the entered services were found in our database.", denominator: "" };
  }
  var rated = found - counts.withheld;
  if (rated === 0) {
    return { grade: "—", label: "No grade", description: "None of the services you entered carries a risk rating. Each row below says why.", denominator: "" };
  }

  var riskyPct = counts.risky / rated;
  var cautionPct = counts.caution / rated;
  var partial = rated < servicesEntered;
  var grade, label, description;
  if (riskyPct === 0 && cautionPct === 0) {
    grade = "A"; label = "Excellent";
    description = partial ? "Every rated service is stable, with no recent pricing concerns." : "All services are stable with no recent pricing concerns.";
  } else if (riskyPct === 0 && cautionPct <= 0.3) {
    grade = "B"; label = "Good"; description = "Mostly stable stack with minor items to monitor.";
  } else if (riskyPct <= 0.2 && cautionPct <= 0.5) {
    grade = "C"; label = "Fair"; description = "Some services at moderate risk — review alternatives for flagged items.";
  } else if (riskyPct <= 0.4) {
    grade = "D"; label = "Poor"; description = "Multiple high-risk services detected — migration planning recommended.";
  } else {
    grade = "F"; label = "Critical";
    description = partial ? "Significant free tier risk across the rated services." : "Significant free tier risk across your stack — immediate action recommended.";
  }
  return { grade: grade, label: label, description: description, denominator: "Grade based on " + rated + " of " + servicesEntered + " services." };
}
