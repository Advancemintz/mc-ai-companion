// Minimal stand-in for mineflayer-pathfinder used only by the simulated-world tests.
// Test stub of mineflayer-pathfinder (only what the code under test touches).
class Goal { constructor (...a) { this.args = a; this.kind = this.constructor.name } }
const goals = {}
for (const n of ['GoalBlock', 'GoalNear', 'GoalXZ', 'GoalNearXZ', 'GoalY', 'GoalGetToBlock', 'GoalLookAtBlock', 'GoalBreakBlock', 'GoalInvert', 'GoalFollow', 'GoalPlaceBlock']) {
  goals[n] = { [n]: class extends Goal {} }[n]
}
class Movements { constructor () { this.scafoldingBlocks = [] } }
module.exports = { goals, Movements, pathfinder: function pathfinder (bot) { bot.pathfinder = { stop () {}, setGoal () {}, goal: null, movements: null, setMovements (m) { this.movements = m }, goto: async () => {} } } }
