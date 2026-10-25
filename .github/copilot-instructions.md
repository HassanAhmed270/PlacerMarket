Task: AB-020 email handling. Change ONLY backend/models/userModel.js and
backend/controller/userController.js (nested repo backend/). Do NOT commit or push.
Show full diffs, then run node --check on both files.

userModel.js
 - email field: add trim: true, lowercase: true; replace the match regex with
   /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/ (keep the message "Please fill a valid email address").

userController.js
 - Add near the top:
     const normalizeEmail = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
     const findUserByEmail = (email) =>
       User.findOne({ email }).collation({ locale: "en", strength: 2 });
 - In register, reVerify, login, forgotPassword, verifyOTP (req.params.email) and
   changePassword (req.params.email): set email = normalizeEmail(input). If it is empty
   (missing or not a string) return 400 with the route's existing "required" message.
   Replace User.findOne({ email }) with findUserByEmail(email).
 - register: store the normalized email in User.create; when sending mail use the
   normalized email.
 - Do not change any other logic: roles, OTP rules, reset token, sessions, messages,
   response shapes.

Then run this and report the output (no repo changes):
 node -e "const r=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;for(const e of ['a@b.com','a@b.tech','a@b.store','a@b.co.uk','a@b','a b@c.com','@c.com','a@.com'])console.log(e,r.test(e))"
Expected: first four true, last four false.