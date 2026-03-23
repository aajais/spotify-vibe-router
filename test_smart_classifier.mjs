import { smartClassifyVibes } from './smart_classify.mjs';

// Test with the actual track that was processed
const testTrack = {
  name: 'Figured Out',
  artists: ['Donn Bhat'],
  explicit: false,
  duration_ms: 194000 // Approximate duration
};

console.log('Testing smart classification with "Figured Out" by Donn Bhat:');
console.log('Track data:', JSON.stringify(testTrack, null, 2));

// Set a timeout to ensure the script completes
setTimeout(() => {
  console.log('Script timed out - there may be an issue with external lookups');
  process.exit(1);
}, 10000);

smartClassifyVibes(testTrack, null).then(results => {
  console.log('Classification completed!');
  console.log('Top classifications:');
  results.slice(0, 5).forEach((result, index) => {
    console.log('  ' + (index+1) + '. ' + result.key + ': ' + result.score.toFixed(2) + ' (' + result.why + ')');
  });
  
  // Check if any score is above 0.55 threshold
  const winners = results.filter(s => s.score >= 0.55);
  console.log('\\nWinners (above 0.55 threshold):', winners.length);
  if (winners.length > 0) {
    console.log('Winning playlists:', winners.map(w => w.key).join(', '));
  } else {
    console.log('Fallback to uncertain');
  }
}).catch(err => {
  console.error('Error in classification:', err);
});