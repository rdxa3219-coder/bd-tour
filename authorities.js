// auth.js - Dynamic Admin Verification Logic
// কোনো হার্ডকোডেড ইমেইল নেই
// Firebase Authentication এবং Firestore Rules-এর ইমেইল মিললেই কেবল প্যানেল আনলক হবে

/**
 * লগইন হ্যান্ডলার:
 * ১. Firebase Authentication-এ ইমেইল ও পাসওয়ার্ড যাচাই করে
 * ২. Firestore Rules-এ এই অ্যাকাউন্টটি অ্যাডমিন হিসেবে অনুমোদিত কিনা সরাসরি সার্ভার রুলস দিয়ে চেক করে
 */
async function handleAdminLogin(e) {
  e.preventDefault();
  const email = document.getElementById('adminEmail').value.trim();
  const pass = document.getElementById('adminPassword').value;

  const submitBtn = document.getElementById('btnAdminSubmit');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = "Verifying Credentials...";
  }

  try {
    // ১. Firebase Authentication-এ সাইন-ইন
    const userCred = await auth.signInWithEmailAndPassword(email, pass);

    // ২. Firestore Rules যাচাই: শুধুমাত্র Rules-এ থাকা isAdmin() ইমেইলই এই ডকুমেন্ট রিড করতে পারে
    await db.collection('admin_credentials').doc('auth').get();

    // ভেরিফিকেশন সফল হলে সেশন সেট করা
    sessionStorage.setItem('admin_auth_token', 'active_session');

    document.getElementById('adminLoginGate').style.display = 'none';
    document.getElementById('adminUserBadge').innerText = userCred.user.email;
    loadAllData();

    showToast('Admin authorized successfully!', 'success');
  } catch (err) {
    // যদি Firebase Rules এর কারণে রিজেক্ট হয়, তবে সাথে সাথে সাইন আউট করে দেওয়া
    if (auth.currentUser) {
      await auth.signOut();
    }
    sessionStorage.removeItem('admin_auth_token');

    const box = document.getElementById('loginBox');
    if (box) {
      box.style.animation = 'shake 0.4s ease';
      setTimeout(() => box.style.animation = '', 450);
    }

    let errMsg = err.message;
    if (err.code === 'permission-denied' || (err.message && err.message.toLowerCase().includes('permission'))) {
      errMsg = 'Access Denied: আপনার ইমেইলটি Firebase Rules-এ অ্যাডমিন হিসেবে অনুমোদিত নয়!';
    } else if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found') {
      errMsg = 'ভুল ইমেইল বা পাসওয়ার্ড! Firebase Authentication-এর সঠিক তথ্য দিন।';
    }
    showToast(errMsg, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = "Authorize Access";
    }
  }
}

/**
 * পেইজ লোড বা রিফ্রেশে সেশন ভ্যালিডেশন
 */
auth.onAuthStateChanged(async (user) => {
  const sessionToken = sessionStorage.getItem('admin_auth_token');
  if (user && (sessionToken === 'active_session' || sessionToken === 'secret_granted')) {
    try {
      // Firebase Rules দিয়ে পুনরায় ভেরিফাই করা
      await db.collection('admin_credentials').doc('auth').get();
      document.getElementById('adminLoginGate').style.display = 'none';
      document.getElementById('adminUserBadge').innerText = user.email || 'Admin';
      loadAllData();
      return;
    } catch (err) {
      console.warn("Rules authorization failed:", err);
      sessionStorage.removeItem('admin_auth_token');
      await auth.signOut();
    }
  }
  document.getElementById('adminLoginGate').style.display = 'flex';
});
