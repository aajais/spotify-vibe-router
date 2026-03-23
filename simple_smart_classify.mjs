// Simplified smart classifier without external lookups
export async function simpleSmartClassifyVibes(track, af) {
  const t = (track.name + " " + track.artists.join(" ")).toLowerCase();
  const scores = [];
  const push = (key, score, why) => scores.push({ key, score, why });

  // Enhanced keyword nudges with better scoring
  if (/(remix|edit|flip|vip|club mix|dub mix|bootleg)/.test(t)) push("velvet_rope", 0.35, "remix/edit cue");
  if (/(live|acoustic|piano version|stripped|unplugged|mtv unplugged)/.test(t)) push("honeyed_home", 0.4, "acoustic/live cue");
  if (/(instrumental|ambient|study|lofi|chill|background|atmosphere)/.test(t)) push("terminal_serenity", 0.45, "instrumental/focus cue");
  if (/(workout|gym|training|beast mode|cardio|fitness|exercise)/.test(t)) push("menace_mileage", 0.4, "workout cue");
  if (/(sad|heartbreak|lonely|melancholy|blue|down|broken)/.test(t)) push("soft_focus", 0.35, "sad/emotional cue");
  if (/(party|celebrat|dance|banger|turn up|lit)/.test(t)) push("neon_cardio", 0.35, "party/dance cue");
  if (/(focus|study|concentration|deep work|productivity)/.test(t)) push("commit_season", 0.4, "focus cue");
  if (/(road trip|driving|cruise|journey|highway)/.test(t)) push("abysride", 0.35, "travel cue");
  if (/(morning|wake up|rise|sun|dawn|daybreak)/.test(t)) push("sunlit_recal", 0.3, "morning/reset cue");
  if (/(cooking|kitchen|recipe|chef|dinner|lunch)/.test(t)) push("stove_clock", 0.3, "cooking cue");
  if (/(coffee|cafe|morning brew|breakfast)/.test(t)) push("sunlit_recal", 0.35, "morning/coffee cue");
  if (/(rain|storm|thunder|nature|forest|waves|ocean)/.test(t)) push("terminal_serenity", 0.4, "nature/ambient cue");
  if (/(retro|80s|90s|nostalgia|vintage)/.test(t)) push("gallery_opening", 0.3, "retro/nostalgic cue");
  if (/(experimental|weird|strange|odd|unusual)/.test(t)) push("left_of_groove", 0.35, "experimental cue");

  // Simple pattern matching for Indian artists (based on common patterns)
  const artistString = track.artists.join(" ").toLowerCase();
  if (artistString.includes("bhat") || artistString.includes("donn") || 
      artistString.includes("indian") || artistString.includes("bollywood") ||
      artistString.includes("hindi") || artistString.includes("desi")) {
    push("cashmere_bg", 0.4, "indian/desi music");
  }

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
    
    // Duration-based classification (more nuanced)
    const durationSec = (track.duration_ms || 0) / 1000;
    if (durationSec > 600) { // Longer than 10 minutes
      push("windowseat_auteur", 0.5, "long track - possibly instrumental/cinematic");
      push("terminal_serenity", 0.45, "long track - ambient");
    } else if (durationSec > 300) { // 5-10 minutes
      push("honeyed_home", 0.45, "medium-long track - possibly classical/acoustic");
    } else if (durationSec < 90) { // Shorter than 90 seconds
      push("neon_cardio", 0.35, "short track - possibly high energy");
      push("errandcore", 0.3, "short track - quick burst");
    }
    
    // Explicit content
    if (track.explicit) {
      push("iron_irreverence", 0.5, "explicit content");
    }
    
    // Album type heuristics
    if (track.album_name) {
      const albumLower = track.album_name.toLowerCase();
      if (albumLower.includes('classical') || albumLower.includes('piano') || albumLower.includes('orchestra')) {
        push("honeyed_home", 0.5, "classical album");
        push("windowseat_auteur", 0.4, "classical - cinematic");
      }
      if (albumLower.includes('greatest hits') || albumLower.includes('best of')) {
        push("monochrome_martini", 0.3, "greatest hits compilation");
      }
      if (albumLower.includes('soundtrack') || albumLower.includes('score')) {
        push("windowseat_auteur", 0.45, "soundtrack - cinematic");
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