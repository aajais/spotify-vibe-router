export function scoreAudioFeatures(af) {
  if (!af) return [];

  const scores = [];
  const push = (key, score, why) => scores.push({ key, score, why });
  const { energy, valence, tempo, danceability, acousticness, speechiness, instrumentalness } = af;

  // Motion
  if (tempo >= 130 && energy >= 0.65) push("neon_cardio", 0.75, "high tempo + high energy");
  if (tempo >= 105 && energy >= 0.5 && tempo < 140) push("fast_not_furious", 0.55, "medium-high tempo + energy");
  if (danceability >= 0.7 && energy >= 0.55) push("errandcore", 0.5, "danceable + upbeat");

  // Cool/social
  if (danceability >= 0.6 && energy >= 0.45 && valence >= 0.35 && valence <= 0.7) push("monochrome_martini", 0.45, "balanced valence + danceability");
  if (danceability >= 0.7 && energy >= 0.65) push("velvet_rope", 0.6, "club-ready energy + danceability");

  // Cozy
  if (acousticness >= 0.55 && energy <= 0.55) push("honeyed_home", 0.55, "acoustic + not too energetic");
  if (energy <= 0.45 && valence >= 0.35 && acousticness >= 0.25) push("cashmere_bg", 0.45, "warm low-energy");

  // Introspective
  if (valence <= 0.4 && energy <= 0.55) push("soft_focus", 0.55, "low valence + moderate/low energy");
  if (valence <= 0.35 && tempo <= 115) push("afterhours", 0.45, "late-night low valence/tempo");
  if (energy <= 0.5 && tempo <= 120) push("abysride", 0.35, "transit-friendly pacing");
  if (instrumentalness >= 0.5 || (energy <= 0.5 && speechiness <= 0.07)) push("windowseat_auteur", 0.4, "spacious/instrumental leaning");

  // Experimental
  if (energy >= 0.65 && danceability <= 0.45) push("left_of_groove", 0.5, "high energy but not danceable");
  if (speechiness <= 0.04 && instrumentalness >= 0.3 && valence >= 0.2 && valence <= 0.6) push("glitch_grace", 0.45, "textural/instrumental blend");

  // Gym menace
  if (energy >= 0.8 && tempo >= 120) push("menace_mileage", 0.6, "very high energy + tempo");

  // Sad bangers
  if (valence <= 0.35 && energy >= 0.6) push("tearjerk_subwoofers", 0.6, "sad valence but high energy");
  if (valence <= 0.4 && danceability >= 0.6) push("crying_designer", 0.5, "sad-ish but danceable");

  // Reset
  if (valence >= 0.45 && energy <= 0.55 && tempo <= 125) push("sunlit_recal", 0.45, "light valence + calm energy");
  if (acousticness >= 0.4 && valence >= 0.45 && energy <= 0.55) push("linen_day", 0.45, "soft acoustic reset");

  // Cooking
  if (tempo >= 85 && tempo <= 120 && danceability >= 0.55 && energy <= 0.7) push("decant_dance", 0.45, "mid tempo groove");
  if (tempo <= 110 && energy <= 0.6 && valence >= 0.35) push("stove_clock", 0.4, "unhurried, warm");

  // Focus
  if (instrumentalness >= 0.6 || (speechiness <= 0.05 && energy >= 0.35 && energy <= 0.65)) push("commit_season", 0.5, "low lyrical distraction + steady energy");
  if (energy <= 0.55 && instrumentalness >= 0.4) push("terminal_serenity", 0.5, "calm instrumental");

  // Aggressive (needs explicit check from track, but we only have af here — caller merges)
  if (energy >= 0.85 && speechiness >= 0.08) push("iron_irreverence", 0.55, "aggressive energy + speechiness");

  return scores;
}
