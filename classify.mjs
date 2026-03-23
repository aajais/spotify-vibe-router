export function classifyVibes(track, af) {
  const t = (track.name + " " + track.artists.join(" ")).toLowerCase();
  const scores = [];
  const push = (key, score, why) => scores.push({ key, score, why });

  // Keyword nudges (always available)
  if (/(remix|edit|flip|vip|club mix|dub mix)/.test(t)) push("velvet_rope", 0.25, "remix/edit cue");
  if (/(live|acoustic|piano version|stripped|unplugged)/.test(t)) push("honeyed_home", 0.3, "acoustic/live cue");
  if (/(instrumental|ambient|study|lofi|chill)/.test(t)) push("terminal_serenity", 0.35, "instrumental/focus cue");
  if (/(workout|gym|training|beast mode)/.test(t)) push("menace_mileage", 0.3, "workout cue");
  if (/(sad|heartbreak|lonely|melancholy)/.test(t)) push("soft_focus", 0.25, "sad/emotional cue");
  if (/(party|celebrat|dance|banger)/.test(t)) push("neon_cardio", 0.25, "party/dance cue");
  if (/(focus|study|concentration|deep work)/.test(t)) push("commit_season", 0.3, "focus cue");
  if (/(road trip|driving|cruise|journey)/.test(t)) push("abysride", 0.25, "travel cue");
  if (/(morning|wake up|rise|sun)/.test(t)) push("sunlit_recal", 0.2, "morning/reset cue");

  if (af) {
    // Audio features classification (when available)
    const { energy, valence, tempo, danceability, acousticness, speechiness, instrumentalness } = af;

    // Motion
    if (tempo >= 130 && energy >= 0.65) push("neon_cardio", 0.75, "high tempo + high energy");
    if (tempo >= 105 && energy >= 0.5 && tempo < 140) push("fast_not_furious", 0.55, "medium-high tempo + energy");
    if (danceability >= 0.7 && energy >= 0.55) push("errandcore", 0.5, "danceable + upbeat");

    // Cool/social
    if (danceability >= 0.6 && energy >= 0.45 && valence >= 0.35 && valence <= 0.7)
      push("monochrome_martini", 0.45, "balanced valence + danceability");
    if (danceability >= 0.7 && energy >= 0.65) push("velvet_rope", 0.6, "club-ready energy + danceability");

    // Cozy
    if (acousticness >= 0.55 && energy <= 0.55) push("honeyed_home", 0.55, "acoustic + not too energetic");
    if (energy <= 0.45 && valence >= 0.35 && acousticness >= 0.25) push("cashmere_bg", 0.45, "warm low-energy");

    // Introspective
    if (valence <= 0.4 && energy <= 0.55) push("soft_focus", 0.55, "low valence + moderate/low energy");
    if (valence <= 0.35 && tempo <= 115) push("afterhours", 0.45, "late-night low valence/tempo");
    if (energy <= 0.5 && tempo <= 120) push("abysride", 0.35, "transit-friendly pacing");
    if (instrumentalness >= 0.5 || (energy <= 0.5 && speechiness <= 0.07))
      push("windowseat_auteur", 0.4, "spacious/instrumental leaning");

    // Experimental/off-beat
    if (energy >= 0.65 && danceability <= 0.45) push("left_of_groove", 0.5, "high energy but not danceable");
    if (speechiness <= 0.04 && instrumentalness >= 0.3 && valence >= 0.2 && valence <= 0.6)
      push("glitch_grace", 0.45, "textural/instrumental blend");

    // Gym menace
    if (energy >= 0.8 && tempo >= 120) push("menace_mileage", 0.6, "very high energy + tempo");
    if (energy >= 0.85 && (speechiness >= 0.08 || track.explicit)) push("iron_irreverence", 0.55, "aggressive energy + (speechiness/explicit)");

    // Sad bangers
    if (valence <= 0.35 && energy >= 0.6) push("tearjerk_subwoofers", 0.6, "sad valence but high energy");
    if (valence <= 0.4 && danceability >= 0.6) push("crying_designer", 0.5, "sad-ish but danceable");

    // Sunday reset
    if (valence >= 0.45 && energy <= 0.55 && tempo <= 125) push("sunlit_recal", 0.45, "light valence + calm energy");
    if (acousticness >= 0.4 && valence >= 0.45 && energy <= 0.55) push("linen_day", 0.45, "soft acoustic reset");

    // Cooking with wine
    if (tempo >= 85 && tempo <= 120 && danceability >= 0.55 && energy <= 0.7) push("decant_dance", 0.45, "mid tempo groove");
    if (tempo <= 110 && energy <= 0.6 && valence >= 0.35) push("stove_clock", 0.4, "unhurried, warm");

    // Focus coding
    if (instrumentalness >= 0.6 || (speechiness <= 0.05 && energy >= 0.35 && energy <= 0.65))
      push("commit_season", 0.5, "low lyrical distraction + steady energy");
    if (energy <= 0.55 && instrumentalness >= 0.4) push("terminal_serenity", 0.5, "calm instrumental");
  } else {
    // Enhanced fallback classification when audio features are not available
    // Use basic track information and heuristics with more sophisticated rules
    
    // Artist-based heuristics (expand this list based on known artists)
    const artistString = track.artists.join(" ").toLowerCase();
    
    // Genre/style indicators from artist names or track titles
    if (artistString.includes("classical") || t.includes("symphony") || t.includes("orchestra") || 
        t.includes("piano") || t.includes("string quartet") || t.includes("concerto")) {
      push("honeyed_home", 0.45, "classical/piano indicator");
      push("windowseat_auteur", 0.4, "classical - cinematic");
    }
    
    if (artistString.includes("edm") || artistString.includes("electronic") || artistString.includes("house") ||
        artistString.includes("techno") || artistString.includes("trance") || t.includes("drop")) {
      push("neon_cardio", 0.5, "electronic/dance indicator");
      push("velvet_rope", 0.45, "electronic - club");
    }
    
    if (artistString.includes("hip hop") || artistString.includes("rap") || t.includes("feat") || 
        t.includes("ft.") || t.includes("mixtape")) {
      push("iron_irreverence", 0.45, "hip hop/rap indicator");
      if (track.explicit) push("iron_irreverence", 0.55, "explicit hip hop");
    }
    
    if (artistString.includes("jazz") || t.includes("smooth jazz") || t.includes("bebop")) {
      push("cashmere_bg", 0.5, "jazz indicator");
      push("honeyed_home", 0.4, "jazz - cozy");
    }
    
    if (artistString.includes("lofi") || t.includes("lofi") || t.includes("chillhop") || 
        t.includes("study beats") || t.includes("focus music")) {
      push("terminal_serenity", 0.6, "lofi/chill indicator");
      push("commit_season", 0.5, "focus music");
    }
    
    if (artistString.includes("metal") || artistString.includes("rock") || t.includes("heavy") ||
        t.includes("aggressive") || t.includes("hardcore")) {
      push("menace_mileage", 0.5, "metal/rock indicator");
      if (track.explicit) push("iron_irreverence", 0.55, "aggressive explicit rock");
    }
    
    if (artistString.includes("indie") || artistString.includes("alternative") || 
        t.includes("indie") || t.includes("alternative")) {
      push("gallery_opening", 0.45, "indie/alternative indicator");
      push("left_of_groove", 0.4, "alternative - experimental");
    }
    
    // Mood indicators from track titles
    if (t.includes("love") || t.includes("romance") || t.includes("heart") || 
        t.includes("affection") || t.includes("passion")) {
      push("monochrome_martini", 0.4, "romantic theme");
    }
    
    if (t.includes("rain") || t.includes("storm") || t.includes("thunder") || 
        t.includes("nature") || t.includes("forest")) {
      push("terminal_serenity", 0.5, "nature/ambient theme");
      push("windowseat_auteur", 0.4, "nature - cinematic");
    }
    
    if (t.includes("coffee") || t.includes("cafe") || t.includes("morning") || 
        t.includes("breakfast") || t.includes("sunrise")) {
      push("sunlit_recal", 0.5, "morning/cafe theme");
      push("cashmere_bg", 0.4, "cozy morning");
    }
    
    if (t.includes("workout") || t.includes("gym") || t.includes("training") || 
        t.includes("exercise") || t.includes("fitness")) {
      push("menace_mileage", 0.55, "workout theme");
      push("neon_cardio", 0.45, "energetic workout");
    }
    
    // Duration-based classification (more nuanced)
    const durationSec = (track.duration_ms || 0) / 1000;
    if (durationSec > 600) { // Longer than 10 minutes
      push("windowseat_auteur", 0.4, "long track - possibly instrumental/cinematic");
      push("terminal_serenity", 0.35, "long track - ambient");
    } else if (durationSec < 120) { // Shorter than 2 minutes
      push("neon_cardio", 0.3, "short track - possibly high energy");
      push("errandcore", 0.25, "short track - quick burst");
    }
    
    // Explicit content
    if (track.explicit) {
      push("iron_irreverence", 0.4, "explicit content");
    }
    
    // Popularity heuristic (if available)
    if (track.popularity !== undefined) {
      if (track.popularity > 70) {
        push("neon_cardio", 0.3, "popular track - likely danceable");
        push("velvet_rope", 0.25, "popular track - mainstream appeal");
      } else if (track.popularity < 30) {
        push("left_of_groove", 0.35, "less popular - possibly experimental");
        push("gallery_opening", 0.3, "niche track");
      }
    }
  }

  // Merge dupes by max score
  const merged = new Map();
  for (const s of scores) {
    const prev = merged.get(s.key);
    if (!prev || s.score > prev.score) merged.set(s.key, s);
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}
