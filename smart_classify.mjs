import fs from 'fs';

// Cache for external lookups to avoid repeated requests
const cache = new Map();

async function fetchWithCache(url, options = {}) {
  if (cache.has(url)) {
    return cache.get(url);
  }
  
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    cache.set(url, data);
    return data;
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    return null;
  }
}

async function getArtistGenresFromExternal(artistName) {
  // This is a simplified example - in reality, you might use:
  // - MusicBrainz API
  // - Last.fm API
  // - Wikipedia API
  // - Or a small LLM call
  
  // For now, let's simulate with some common patterns
  const artistLower = artistName.toLowerCase();
  
  // Common genre associations (this would be much more sophisticated in practice)
  const genreMap = {
    'classical': ['classical', 'orchestral', 'piano'],
    'piano': ['classical', 'piano', 'instrumental'],
    'orchestra': ['classical', 'orchestral'],
    'edm': ['electronic', 'dance', 'edm'],
    'electronic': ['electronic', 'synth'],
    'house': ['electronic', 'house', 'dance'],
    'techno': ['electronic', 'techno', 'dance'],
    'hip hop': ['hip hop', 'rap'],
    'rap': ['hip hop', 'rap'],
    'jazz': ['jazz', 'improvisation'],
    'lofi': ['lofi', 'chill', 'study'],
    'metal': ['metal', 'heavy', 'rock'],
    'rock': ['rock', 'guitar'],
    'indie': ['indie', 'alternative'],
    'alternative': ['indie', 'alternative'],
    'pop': ['pop'],
    'r&b': ['r&b', 'soul'],
    'soul': ['r&b', 'soul'],
    'folk': ['folk', 'acoustic'],
    'country': ['country'],
    'reggae': ['reggae'],
    'latin': ['latin'],
    'kpop': ['kpop', 'pop'],
    'bollywood': ['bollywood', 'indian'],
    'bengali': ['bengali', 'indian'],
    'hindi': ['hindi', 'indian'],
    'punjabi': ['punjabi', 'indian'],
    'telugu': ['telugu', 'indian'],
    'tamil': ['tamil', 'indian'],
    'malayalam': ['malayalam', 'indian']
  };
  
  for (const [keyword, genres] of Object.entries(genreMap)) {
    if (artistLower.includes(keyword)) {
      return genres;
    }
  }
  
  return [];
}

async function getTrackMoodFromTitle(trackName) {
  const titleLower = trackName.toLowerCase();
  
  const moodIndicators = {
    'workout': 'energetic',
    'gym': 'energetic',
    'motivation': 'energetic',
    'party': 'party',
    'celebrat': 'party',
    'dance': 'dance',
    'chill': 'chill',
    'relax': 'chill',
    'calm': 'chill',
    'study': 'focus',
    'focus': 'focus',
    'concentration': 'focus',
    'sleep': 'sleep',
    'bedtime': 'sleep',
    'morning': 'uplifting',
    'sunrise': 'uplifting',
    'happy': 'uplifting',
    'joy': 'uplifting',
    'sad': 'melancholy',
    'heartbreak': 'melancholy',
    'lonely': 'melancholy',
    'melancholy': 'melancholy',
    'rain': 'atmospheric',
    'storm': 'atmospheric',
    'nature': 'atmospheric',
    'ambient': 'atmospheric'
  };
  
  for (const [keyword, mood] of Object.entries(moodIndicators)) {
    if (titleLower.includes(keyword)) {
      return mood;
    }
  }
  
  return 'neutral';
}

export async function smartClassifyVibes(track, af) {
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

  // External data enrichment
  const allGenres = new Set();
  const allMoods = new Set();
  
  // Get genres for each artist
  for (const artistName of track.artists) {
    const genres = await getArtistGenresFromExternal(artistName);
    genres.forEach(genre => allGenres.add(genre));
  }
  
  // Get mood from track title
  const titleMood = await getTrackMoodFromTitle(track.name);
  allMoods.add(titleMood);
  
  // Genre-based classification
  if (allGenres.has('classical') || allGenres.has('piano') || allGenres.has('orchestral')) {
    push("honeyed_home", 0.5, "classical/piano genre");
    push("windowseat_auteur", 0.45, "classical - cinematic");
  }
  
  if (allGenres.has('electronic') || allGenres.has('edm') || allGenres.has('house') || allGenres.has('techno')) {
    push("neon_cardio", 0.5, "electronic/dance genre");
    push("velvet_rope", 0.45, "electronic - club");
  }
  
  if (allGenres.has('hip hop') || allGenres.has('rap')) {
    push("iron_irreverence", 0.45, "hip hop/rap genre");
    if (track.explicit) push("iron_irreverence", 0.55, "explicit hip hop");
  }
  
  if (allGenres.has('jazz')) {
    push("cashmere_bg", 0.55, "jazz genre");
    push("honeyed_home", 0.45, "jazz - cozy");
  }
  
  if (allGenres.has('lofi') || allGenres.has('chill')) {
    push("terminal_serenity", 0.65, "lofi/chill genre");
    push("commit_season", 0.55, "focus music");
  }
  
  if (allGenres.has('metal') || allGenres.has('rock')) {
    push("menace_mileage", 0.55, "metal/rock genre");
    if (track.explicit) push("iron_irreverence", 0.6, "aggressive explicit rock");
  }
  
  if (allGenres.has('indie') || allGenres.has('alternative')) {
    push("gallery_opening", 0.5, "indie/alternative genre");
    push("left_of_groove", 0.45, "alternative - experimental");
  }
  
  if (allGenres.has('indian') || allGenres.has('bollywood') || allGenres.has('bengali')) {
    push("cashmere_bg", 0.4, "indian music");
  }
  
  // Mood-based classification
  if (allMoods.has('energetic')) {
    push("neon_cardio", 0.4, "energetic mood");
    push("menace_mileage", 0.35, "high energy");
  }
  
  if (allMoods.has('chill') || allMoods.has('atmospheric')) {
    push("terminal_serenity", 0.5, "chill/atmospheric mood");
    push("windowseat_auteur", 0.4, "atmospheric - cinematic");
  }
  
  if (allMoods.has('focus')) {
    push("commit_season", 0.5, "focus mood");
    push("terminal_serenity", 0.4, "concentration");
  }
  
  if (allMoods.has('party')) {
    push("velvet_rope", 0.5, "party mood");
    push("neon_cardio", 0.45, "celebration");
  }
  
  if (allMoods.has('melancholy')) {
    push("soft_focus", 0.5, "melancholy mood");
    push("afterhours", 0.45, "sad/emotional");
  }
  
  if (allMoods.has('uplifting')) {
    push("sunlit_recal", 0.45, "uplifting mood");
    push("errandcore", 0.4, "positive energy");
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