import { smartClassifyVibes } from './smart_classify.mjs';

// Test with the actual track that was processed
const testTrack = {
  name: 'Figured Out',
  artists: ['Donn Bhat'],
  explicit: false,
  duration_ms: 194000 // Approximate duration
};

console.log('Testing smart classification with "Figured Out" by Donn Bhat:');

smartClassifyVibes(testTrack, null).then(results => {
  console.log('All classifications (sorted by score):');
  results.forEach((result, index) => {
    console.log('  ' + (index+1) + '. ' + result.key + ': ' + result.score.toFixed(2) + ' (' + result.why + ')');
  });
  
  // Show top 3 scores
  console.log('\\nTop 3 scores:');
  results.slice(0, 3).forEach((result, index) => {
    console.log('  ' + (index+1) + '. ' + result.key + ': ' + result.score.toFixed(2));
  });
  
  // Check if any score is above 0.55 threshold
  const winners = results.filter(s => s.score >= 0.55);
  console.log('\\nScores above 0.55 threshold:', winners.length);
  if (winners.length > 0) {
    console.log('Winning playlists:', winners.map(w => w.key).join(', '));
  } else {
    console.log('Fallback to uncertain (no scores above 0.55)');
  }
  
  // Show the threshold
  console.log('\\nThreshold for playlist assignment: 0.55');
}).catch(err => {
  console.error('Error in classification:', err);
});