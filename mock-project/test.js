import { add } from './math.js';

console.log("Running tests...");
if (add(2, 3) !== 5) {
  console.error("Test failed: add(2, 3) should be 5, but got " + add(2, 3));
  process.exit(1);
}
console.log("Tests passed!");
process.exit(0);
