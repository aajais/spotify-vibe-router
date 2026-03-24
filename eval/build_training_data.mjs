import fs from 'fs';
import { VIBES } from './vibes.mjs';

const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
const token = state.token.access_token;

async function getPlaylistTracks(playlistId) {
  const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  return await response.json();
}

async function getTrackFeatures(trackIds) {
  if (trackIds.length === 0) return {};
  
  // Chunk into groups of 100
  const chunks = [];
  for (let i = 0; i < trackIds.length; i += 100) {
    chunks.push(trackIds.slice(i, i + 100));
  }
  
  const allFeatures = {};
  for (const chunk of chunks) {
    try {
      const response = await fetch(`https://api.spotify.com/v1/audio-features?ids=${chunk.join(',')}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.status === 200) {
        const data = await response.json();
        data.audio_features.forEach(feature => {
          if (feature) {
            allFeatures[feature.id] = feature;
          }
        });
      } else {
        console.log(`Audio features request failed with status ${response.status}`);
      }
    } catch (error) {
      console.error('Error fetching audio features:', error);
    }
  }
  
  return allFeatures;
}

async function getArtistInfo(artistIds) {
  if (artistIds.length === 0) return {};
  
  // Remove duplicates
  const uniqueIds = [...new Set(artistIds)];
  
  const artistInfo = {};
  for (const artistId of uniqueIds) {
    try {
      const response = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.status === 200) {
        const data = await response.json();
        artistInfo[artistId] = {
          name: data.name,
          genres: data.genres || [],
          popularity: data.popularity
        };
      }
    } catch (error) {
      console.error(`Error fetching artist info for ${artistId}:`, error);
    }
  }
  
  return artistInfo;
}

async function buildTrainingDataset() {
  console.log('Building training dataset from your vibe playlists...');
  
  // Load playlist mapping from state
  const playlistMap = state.playlistMap || {};
  
  const trainingData = [];
  const allArtistIds = new Set();
  
  // Process each vibe playlist
  for (const vibe of VIBES) {
    const playlistId = playlistMap[vibe.key];
    if (!playlistId) {
      console.log(`Skipping ${vibe.name} - no playlist found`);
      continue;
    }
    
    console.log(`Processing ${vibe.name}...`);
    
    try {
      const playlistData = await getPlaylistTracks(playlistId);
      const tracks = playlistData.items
        .filter(item => item.item && item.item.type === 'track')
        .map(item => item.item);
      
      console.log(`  Found ${tracks.length} tracks`);
      
      // Collect track IDs and artist IDs
      const trackIds = tracks.map(track => track.id).filter(id => id);
      const artistIds = tracks.flatMap(track => 
        track.artists.map(artist => artist.id)
      ).filter(id => id);
      
      artistIds.forEach(id => allArtistIds.add(id));
      
      // Get audio features (if available)
      const features = await getTrackFeatures(trackIds);
      
      // Build training examples
      for (const track of tracks) {
        if (!track.id) continue;
        
        const example = {
          track_id: track.id,
          track_name: track.name,
          artist_names: track.artists.map(a => a.name),
          album_name: track.album?.name,
          duration_ms: track.duration_ms,
          explicit: track.explicit,
          // Audio features (may be null if unavailable)
          audio_features: features[track.id] || null,
          // Will be filled with artist info later
          artist_info: {},
          vibe_label: vibe.key
        };
        
        trainingData.push(example);
      }
    } catch (error) {
      console.error(`Error processing ${vibe.name}:`, error);
    }
  }
  
  // Get artist information
  console.log('Fetching artist information...');
  const artistInfo = await getArtistInfo([...allArtistIds]);
  
  // Attach artist info to training examples
  trainingData.forEach(example => {
    const artistIds = example.artist_names.map((name, index) => {
      const artist = example.item?.artists[index];
      return artist ? artist.id : null;
    }).filter(id => id);
    
    example.artist_info = artistIds.map(id => artistInfo[id]).filter(info => info);
  });
  
  // Save training data
  const output = {
    created_at: new Date().toISOString(),
    total_examples: trainingData.length,
    data: trainingData
  };
  
  fs.writeFileSync('training_data.json', JSON.stringify(output, null, 2));
  console.log(`Training data saved to training_data.json (${trainingData.length} examples)`);
  
  // Print some statistics
  const vibeCounts = {};
  trainingData.forEach(example => {
    vibeCounts[example.vibe_label] = (vibeCounts[example.vibe_label] || 0) + 1;
  });
  
  console.log('\\nVibe distribution:');
  Object.entries(vibeCounts)
    .sort(([,a], [,b]) => b - a)
    .forEach(([vibe, count]) => {
      const vibeName = VIBES.find(v => v.key === vibe)?.name || vibe;
      console.log(`  ${vibeName}: ${count}`);
    });
}

// Run the script
buildTrainingDataset().catch(console.error);