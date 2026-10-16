const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();
const ADMIN_EMAIL = 'jubayed@gmail.com';

function requireUser(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in first.');
  return req.auth.uid;
}
function requireAdmin(req) {
  const uid = requireUser(req);
  if (req.auth.token.email !== ADMIN_EMAIL || req.auth.token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
  return uid;
}
function validAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1000000) throw new HttpsError('invalid-argument', 'Invalid amount.');
  return Math.round(n * 100) / 100;
}

exports.joinTournamentMatch = onCall(async (req) => {
  const uid = requireUser(req);
  const { matchId, chosenSlot, players, matchType } = req.data || {};
  if (typeof matchId !== 'string' || !matchId || !Number.isInteger(Number(chosenSlot)) || !Array.isArray(players)) {
    throw new HttpsError('invalid-argument', 'Invalid match or player details.');
  }
  const slot = Number(chosenSlot);
  const cleanedPlayers = players.map((p) => ({
    ign: String(p?.ign || '').trim().slice(0, 40),
    gameUid: String(p?.gameUid || '').trim().slice(0, 40),
    role: String(p?.role || 'Member').slice(0, 20)
  }));
  const type = String(matchType || 'Solo').toLowerCase();
  const expectedCount = type === 'duo' ? 2 : type === 'squad' ? 4 : 1;
  if (cleanedPlayers.length !== expectedCount || cleanedPlayers.some(p => !p.ign || !p.gameUid)) {
    throw new HttpsError('invalid-argument', `Enter all ${expectedCount} player names and game UIDs.`);
  }
  const matchRef = db.collection('matches').doc(matchId);
  const participantsRef = db.collection('match_participants').doc(matchId);
  const userRef = db.collection('users').doc(uid);
  const txRef = db.collection('transactions').doc(uid).collection('items').doc();
  let result;
  await db.runTransaction(async (tx) => {
    const [matchSnap, participantSnap, userSnap] = await Promise.all([
      tx.get(matchRef), tx.get(participantsRef), tx.get(userRef)
    ]);
    if (!matchSnap.exists || !userSnap.exists) throw new HttpsError('not-found', 'Match or user profile not found.');
    const match = matchSnap.data();
    const user = userSnap.data();
    if (['Ongoing', 'Finished', 'Cancelled'].includes(match.status)) throw new HttpsError('failed-precondition', 'This match is closed.');
    if (user.banned === true) throw new HttpsError('permission-denied', 'This account is restricted.');
    const totalSlots = Number(match.total_slots) || 48;
    if ((Number(match.joined) || 0) >= totalSlots) throw new HttpsError('failed-precondition', 'All slots are full.');
    if (slot < 1 || slot > totalSlots) throw new HttpsError('invalid-argument', 'Invalid slot number.');
    const participants = participantSnap.exists ? participantSnap.data() : {};
    if (participants[uid]) throw new HttpsError('already-exists', 'You have already joined this match.');
    if (Object.values(participants).some(p => Number(p?.slot) === slot)) throw new HttpsError('already-exists', 'This slot has already been taken. Please choose another slot.');
    const fee = Math.max(0, Number(match.entry_fee) || 0);
    const deposit = Number(user.deposit) || 0;
    const winning = Number(user.winning) || 0;
    if (deposit + winning < fee) throw new HttpsError('failed-precondition', 'Insufficient balance.');
    const fromDeposit = Math.min(deposit, fee);
    const fromWinning = fee - fromDeposit;
    const ign = cleanedPlayers.map(p => p.ign).join(', ');
    const participant = {
      username: String(user.username || user.name || 'Player').slice(0, 80),
      phone: String(user.phone || '').slice(0, 30), ign,
      players: cleanedPlayers, playerCount: cleanedPlayers.length, slot,
      matchType: match.type || 'Solo', result: null, prize_earned: 0,
      joinedAt: Date.now()
    };
    tx.set(participantsRef, { [uid]: participant }, { merge: true });
    tx.update(matchRef, {
      joined: (Number(match.joined) || 0) + 1,
      [`participants.${uid}`]: { slot, ign, players: cleanedPlayers, playerCount: cleanedPlayers.length }
    });
    tx.update(userRef, { deposit: deposit - fromDeposit, winning: winning - fromWinning });
    tx.set(txRef, {
      type: 'join_fee', amount: fee,
      description: `Joined ${String(match.title || 'match').slice(0, 100)} (${match.type || 'Solo'} - Slot #${slot}: ${ign})`,
      status: 'completed', date: Date.now(), matchId
    });
    result = { slotNumber: slot, remainingSlots: Math.max(totalSlots - ((Number(match.joined) || 0) + 1), 0) };
  });
  return result;
});

exports.requestWithdrawal = onCall(async (req) => {
  const uid = requireUser(req);
  const amount = validAmount(req.data?.amount);
  const method = String(req.data?.method || '').trim();
  const number = String(req.data?.number || '').trim().slice(0, 40);
  if (!['bKash', 'Nagad', 'Rocket', 'Bkash', 'bkash', 'nagad', 'rocket'].includes(method) || number.length < 5) {
    throw new HttpsError('invalid-argument', 'Enter a valid withdrawal method and account number.');
  }
  const userRef = db.collection('users').doc(uid);
  const withdrawalRef = db.collection('withdrawals').doc();
  const txRef = db.collection('transactions').doc(uid).collection('items').doc(withdrawalRef.id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new HttpsError('not-found', 'User profile not found.');
    const user = snap.data();
    const settingsSnap = await tx.get(db.collection('app_settings').doc('config'));
    const min = Number(settingsSnap.exists ? settingsSnap.data().min_withdraw : 50) || 50;
    const winning = Number(user.winning) || 0;
    if (amount < min) throw new HttpsError('failed-precondition', `Minimum withdrawal is ৳${min}.`);
    if (amount > winning) throw new HttpsError('failed-precondition', 'Withdrawal amount exceeds winning balance.');
    tx.update(userRef, { winning: winning - amount });
    tx.set(withdrawalRef, { uid, username: String(user.username || user.name || 'Player'), amount, method, number, requestedAt: Date.now(), status: 'pending', processedAt: null });
    tx.set(txRef, { type: 'withdrawal', amount, description: `Withdrawal via ${method} to ${number}`, status: 'pending', date: Date.now() });
  });
  return { withdrawalId: withdrawalRef.id };
});

exports.createDepositRequest = onCall(async (req) => {
  const uid = requireUser(req);
  const amount = validAmount(req.data?.amount);
  const trxId = String(req.data?.trxId || '').trim().toUpperCase();
  const method = String(req.data?.method || '').trim();
  if (!/^[A-Z0-9-]{5,40}$/.test(trxId) || !['bKash', 'Nagad', 'Rocket', 'Bkash', 'bkash', 'nagad', 'rocket'].includes(method)) {
    throw new HttpsError('invalid-argument', 'Invalid transaction ID or payment method.');
  }
  const userRef = db.collection('users').doc(uid);
  const payRef = db.collection('Auto_Pay').doc(trxId);
  const txRef = db.collection('transactions').doc(uid).collection('items').doc(trxId);
  await db.runTransaction(async (tx) => {
    const [userSnap, paySnap] = await Promise.all([tx.get(userRef), tx.get(payRef)]);
    if (!userSnap.exists) throw new HttpsError('not-found', 'User profile not found.');
    if (paySnap.exists) throw new HttpsError('already-exists', 'This transaction ID has already been submitted.');
    const user = userSnap.data();
    const settingsSnap = await tx.get(db.collection('app_settings').doc('config'));
    const min = Number(settingsSnap.exists ? settingsSnap.data().min_deposit : 10) || 10;
    if (amount < min) throw new HttpsError('failed-precondition', `Minimum deposit is ৳${min}.`);
    tx.set(payRef, { amount, method, userUid: uid, username: String(user.username || user.name || 'Player'), userPhone: String(user.phone || 'N/A'), status: 'pending', addedBy: 'User', addedAt: Date.now() });
    tx.set(txRef, { type: 'deposit', amount, description: `Deposit via ${method} (TrxID: ${trxId})`, status: 'pending', date: Date.now() });
  });
  return { transactionId: trxId };
});

exports.applyReferralBonus = onCall(async (req) => {
  const uid = requireUser(req);
  const code = String(req.data?.refCode || '').trim().toUpperCase();
  if (!code) return { applied: false };
  const userRef = db.collection('users').doc(uid);
  const refQuery = await db.collection('users').where('referCode', '==', code).limit(1).get();
  if (refQuery.empty || refQuery.docs[0].id === uid) return { applied: false };
  const refRef = refQuery.docs[0].ref;
  const refTxRef = db.collection('transactions').doc(refRef.id).collection('items').doc();
  await db.runTransaction(async (tx) => {
    const [userSnap, refSnap, settingsSnap] = await Promise.all([
      tx.get(userRef), tx.get(refRef), tx.get(db.collection('app_settings').doc('config'))
    ]);
    if (!userSnap.exists || !refSnap.exists) throw new HttpsError('not-found', 'Referral profile not found.');
    const user = userSnap.data();
    if (user.referralBonusApplied === true || user.referredBy) return;
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const refereeBonus = Math.max(0, Number(settings.refer_bonus_referee) || 0);
    const referrerBonus = Math.max(0, Number(settings.refer_bonus_referrer) || 0);
    tx.update(userRef, { deposit: (Number(user.deposit) || 0) + refereeBonus, referredBy: refRef.id, referralBonusApplied: true });
    tx.update(refRef, { deposit: (Number(refSnap.data().deposit) || 0) + referrerBonus, referralCount: (Number(refSnap.data().referralCount) || 0) + 1, referralEarned: (Number(refSnap.data().referralEarned) || 0) + referrerBonus });
    tx.set(refTxRef, { type: 'referral', amount: referrerBonus, description: `Referral bonus from ${String(user.username || 'new user').slice(0, 80)}`, status: 'completed', date: Date.now() });
  });
  return { applied: true };
});
