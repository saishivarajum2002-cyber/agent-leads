const { generateDescription } = require('./services/ai.js');

const tests = [
  '3BR villa, 3000 sqft, pool, sea view, Palm Jumeirah, $2.4M',
  '2 bedroom apartment, 1200 sqft, balcony, city view, Dubai Marina',
  'Studio, 450 sqft, fully furnished, smart home, Business Bay',
  '5BR mansion, 8000 sqft, pool, garden, garage, Emirates Hills, $5M',
  '4br penthouse, 5000 sqft, terrace, open plan, DIFC',
  '3bhk 3000sqrf located in USA dallas',
];

(async () => {
  console.log('=== PropEdge Local AI Description Generator Test ===\n');
  for (const t of tests) {
    const res = await generateDescription(t);
    console.log('INPUT :', t);
    console.log('OUTPUT:', res.text);
    console.log('OK    :', res.success ? 'YES' : 'NO');
    console.log('');
  }
  console.log('=== All tests complete ===');
})();
