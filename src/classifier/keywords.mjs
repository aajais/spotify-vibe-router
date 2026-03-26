export function scoreKeywords(track) {
  const t = (track.name + " " + track.artists.join(" ")).toLowerCase();
  const scores = [];
  const push = (key, score, why) => scores.push({ key, score, why });

  // Track title / artist keyword cues
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

  // Artist-based genre heuristics
  const artistString = track.artists.join(" ").toLowerCase();
  if (artistString.includes("bhat") || artistString.includes("donn") || artistString.includes("indian") || artistString.includes("bollywood") || artistString.includes("hindi") || artistString.includes("desi")) {
    push("cashmere_bg", 0.4, "indian/desi music");
  }

  // Genre indicators from artist/title text (fallback heuristics from classify.mjs)
  if (artistString.includes("classical") || t.includes("symphony") || t.includes("orchestra") || t.includes("piano") || t.includes("string quartet") || t.includes("concerto")) {
    push("honeyed_home", 0.45, "classical/piano indicator");
    push("windowseat_auteur", 0.4, "classical - cinematic");
  }
  if (artistString.includes("edm") || artistString.includes("electronic") || artistString.includes("house") || artistString.includes("techno") || artistString.includes("trance") || t.includes("drop")) {
    push("neon_cardio", 0.5, "electronic/dance indicator");
    push("velvet_rope", 0.45, "electronic - club");
  }
  if (artistString.includes("hip hop") || artistString.includes("rap") || t.includes("feat") || t.includes("ft.") || t.includes("mixtape")) {
    push("iron_irreverence", 0.45, "hip hop/rap indicator");
    if (track.explicit) push("iron_irreverence", 0.55, "explicit hip hop");
  }
  if (artistString.includes("jazz") || t.includes("smooth jazz") || t.includes("bebop")) {
    push("cashmere_bg", 0.5, "jazz indicator");
    push("honeyed_home", 0.4, "jazz - cozy");
  }
  if (artistString.includes("lofi") || t.includes("lofi") || t.includes("chillhop") || t.includes("study beats") || t.includes("focus music")) {
    push("terminal_serenity", 0.6, "lofi/chill indicator");
    push("commit_season", 0.5, "focus music");
  }
  if (artistString.includes("metal") || artistString.includes("rock") || t.includes("heavy") || t.includes("aggressive") || t.includes("hardcore")) {
    push("menace_mileage", 0.5, "metal/rock indicator");
    if (track.explicit) push("iron_irreverence", 0.55, "aggressive explicit rock");
  }
  if (artistString.includes("indie") || artistString.includes("alternative") || t.includes("indie") || t.includes("alternative")) {
    push("gallery_opening", 0.45, "indie/alternative indicator");
    push("left_of_groove", 0.4, "alternative - experimental");
  }

  // Mood indicators
  if (t.includes("love") || t.includes("romance") || t.includes("heart") || t.includes("affection") || t.includes("passion")) push("monochrome_martini", 0.4, "romantic theme");
  if (t.includes("rain") || t.includes("storm") || t.includes("thunder") || t.includes("nature") || t.includes("forest")) {
    push("terminal_serenity", 0.5, "nature/ambient theme");
    push("windowseat_auteur", 0.4, "nature - cinematic");
  }
  if (t.includes("coffee") || t.includes("cafe") || t.includes("morning") || t.includes("breakfast") || t.includes("sunrise")) {
    push("sunlit_recal", 0.5, "morning/cafe theme");
    push("cashmere_bg", 0.4, "cozy morning");
  }

  // Duration-based
  const durationSec = (track.duration_ms || 0) / 1000;
  if (durationSec > 600) {
    push("windowseat_auteur", 0.5, "long track - possibly instrumental/cinematic");
    push("terminal_serenity", 0.45, "long track - ambient");
  } else if (durationSec > 300) {
    push("honeyed_home", 0.45, "medium-long track - possibly classical/acoustic");
  } else if (durationSec < 90) {
    push("neon_cardio", 0.35, "short track - possibly high energy");
    push("errandcore", 0.3, "short track - quick burst");
  }

  // Explicit content
  if (track.explicit) push("iron_irreverence", 0.5, "explicit content");

  return scores;
}
