// tournament_logic.js - Match & Slot Management Engine for BD Tour (Firebase Firestore)

/**
 * 1. Admin Match Slot & Type Config
 * @param {string} type - 'Solo' | 'Duo' | 'Squad'
 * @returns {number} Default slot count based on tournament type
 */
function getDefaultSlotsForType(type) {
  switch (type.toLowerCase()) {
    case 'duo': return 24;
    case 'squad': return 12;
    case 'solo':
    default: return 48;
  }
}

/**
 * 2. Get Available Slots for a Match
 * @param {string} matchId
 * @param {number} totalSlots
 * @returns {Promise<number[]>} Array of unoccupied slot numbers
 */
async function getAvailableSlots(matchId, totalSlots) {
  const snap = await db.collection('match_participants').doc(matchId).get();
  const participants = snap.exists ? snap.data() : {};
  const takenSlots = new Set();

  Object.values(participants).forEach(p => {
    if (p.slot) takenSlots.add(Number(p.slot));
  });

  const available = [];
  for (let s = 1; s <= totalSlots; s++) {
    if (!takenSlots.has(s)) {
      available.push(s);
    }
  }
  return available;
}

/**
 * 3. User Tournament Join Handler (Solo / Duo / Squad + Slot Assignment + Game Profile UID)
 * @param {Object} params
 * @param {string} params.matchId
 * @param {string} params.matchType - 'Solo' | 'Duo' | 'Squad'
 * @param {number} params.chosenSlot
 * @param {Array<{ign: string, gameUid: string, role?: string}>} params.players - Array of player objects with IGN and Game Profile UID
 * @param {Object} params.user - Current user { uid, username, phone }
 * @param {number} params.entryFee
 */
async function joinTournamentMatch({ matchId, matchType, chosenSlot, players, user, entryFee }) {
  const matchRef = db.collection('matches').doc(matchId);
  const matchSnap = await matchRef.get();
  if (!matchSnap.exists) throw new Error('ম্যাচটি খুঁজে পাওয়া যায়নি।');

  const matchData = matchSnap.data();
  if (matchData.status === 'Ongoing' || matchData.status === 'Finished') {
    throw new Error('এই ম্যাচটিতে আর জয়েন করার সুযোগ নেই (ম্যাচ লাইভ বা সমাপ্ত)।');
  }

  const totalSlots = Number(matchData.total_slots) || 48;
  const currentJoined = Number(matchData.joined) || 0;
  if (currentJoined >= totalSlots) {
    throw new Error('এই টুর্নামেন্টের সকল স্লট ইতিমধ্যে পূর্ণ হয়ে গেছে।');
  }

  // Validate players and extract combined IGN string
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('দয়া করে খেলোয়াড়দের তথ্য পূরণ করুন।');
  }

  // Ensure every player has both In-Game Name (IGN) and Game Profile UID
  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    if (!pl.ign || !pl.ign.trim()) {
      throw new Error(`Player ${i + 1}-এর In-Game Name (IGN) পূরণ করা বাধ্যতামূলক।`);
    }
    if (!pl.gameUid || !pl.gameUid.trim()) {
      throw new Error(`Player ${i + 1}-এর Game Profile UID পূরণ করা বাধ্যতামূলক।`);
    }
  }

  const formattedIGN = players.map(p => p.ign.trim()).join(', ');
  const playerCount = players.length;

  // Save participant profile under match_participants with IGN and Game Profile UIDs
  await db.collection('match_participants').doc(matchId).set({
    [user.uid]: {
      username: user.username || 'Player',
      phone: user.phone || '',
      ign: formattedIGN,
      players: players,
      playerCount: playerCount,
      slot: chosenSlot,
      matchType: matchType,
      result: null,
      prize_earned: 0,
      joinedAt: Date.now()
    }
  }, { merge: true });

  const newJoinedCount = currentJoined + 1;
  const remainingSlots = Math.max(totalSlots - newJoinedCount, 0);

  // Update match document
  await matchRef.update({
    joined: newJoinedCount,
    [`participants.${user.uid}`]: {
      slot: chosenSlot,
      ign: formattedIGN,
      players: players,
      playerCount: playerCount
    }
  });

  return {
    slotNumber: chosenSlot,
    remainingSlots: remainingSlots,
    totalSlots: totalSlots,
    formattedIGN: formattedIGN,
    playerCount: playerCount,
    players: players
  };
}

/**
 * 4. 24-Hour Auto Expiration Check for Finished Matches
 * @param {Object} match - Match document data
 * @returns {boolean} Whether match has been finished for 24+ hours
 */
function isMatchExpired24Hours(match) {
  if (match.status !== 'Finished' || !match.finishedAt) return false;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  return (Date.now() - match.finishedAt) >= TWENTY_FOUR_HOURS;
}