/**
 * What BNB Chain checks a Set and Earn agent against after the campaign
 * closes, in its words (the campaign page, Tracks), for every page that
 * states them: /build, /check, the quest.
 */
export const QUALIFIES = [
  ["Registered and owned", "On the ERC-8004 identity registry (chain 56 or 97), owned by your registered campaign wallet, and listed on a shortlisted marketplace."],
  ["Discoverable", "A card at its registered domain that says what it does and which job it does: yield, grid, rebalancing or health factor."],
  ["Live", "It answers when called. BNB Chain probes at random times."],
  ["Hired by others", "At least three completed hires, from three different wallets that are not yours and not funded by yours."],
  ["Actually executes", "At least five onchain actions of its own, on at least three different days."],
  ["Does what it says", "Those actions fit its job: a yield agent uses lending or vault contracts, a grid agent trades repeatedly, a rebalancing agent adjusts positions, a health-factor agent watches and acts on loans."],
] as const;
