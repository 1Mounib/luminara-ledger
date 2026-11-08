# Deploying TaxMate (free)

You need two free accounts: **GitHub**, which stores the code, and **Vercel**, which hosts the website. A **Groq** key is optional; it turns on the cloud AI.

## 1. Put the code on GitHub
1. Create a private repository called `TaxMate`.
2. Upload the project files, keeping the folder structure.

## 2. Publish with Vercel
1. Go to **vercel.com** and choose **Sign up**, then **Continue with GitHub**. Pick the free **Hobby** plan.
2. Click **Add New... → Project**, then **Import** next to `Taxmate`.
3. Leave the settings as they are. Framework Preset is **Other**, and there's no build command.
4. Click **Deploy**. About 30 seconds later you get a link like `TaxMate-xxxx.vercel.app`.

The site works now, using the on-device agents.

## 3. Turn on the cloud AI (Engine B)
1. Go to **aistudio.google.com**, click **Get API key**, then **Create API key**, and copy it.
   (Groq also works via `GROQ_API_KEY`, but it blocked sign-ups from outlook.com and student emails.)
2. In Vercel, open the project and go to **Settings**, then **Environment Variables**. Add:
   - Key `GEMINI_API_KEY`
   - Value: the key
   - Click **Save**
3. Go to **Deployments**, click **...** on the latest one, and choose **Redeploy**.
4. Check it works by opening `https://<your-site>/api/health?ping=1`. It should show `"ping": {"ok": true, ...}`.
5. In the app, the status line in panel 1 should say *"Dual-engine - masked data to Google Gemini"*.

## 4. Turn on accounts and the shared database (Supabase, free)
1. Create a free project at **supabase.com** with the region set to **Sydney**.
2. Put its **Project URL** and **publishable key** in `public/js/config.js`. These are public by design; never put the secret key there.
3. In Supabase, open **SQL Editor**, click **New query**, paste the whole of `supabase/schema.sql` and click **Run**. It should say *Success. No rows returned*.
4. In Supabase, go to **Authentication**, then **Sign In / Providers**, then **Email**. Turn **Confirm email** **off** and click **Save**. Supabase's free email service only delivers to project members, so confirmation emails wouldn't reach other users.
5. Create the accounts on the website:
   - taxpayers choose **Taxpayer**;
   - accountants choose **Accountant** and enter the **practice code** (`TaxMate-2026` unless you changed it).
   To change the code, run `update private.settings set value = 'NEW-CODE' where key = 'practice_code';` in the SQL Editor.

What is stored where:
| Where | What |
|---|---|
| Taxpayer's own device (encrypted, AES-256-GCM) | original files, the real text of each line, the PII token map |
| Supabase (Sydney), protected by Row Level Security | masked lines and their positions, the calculated result, flags, the audit log |
| Google Gemini | masked text only, for each analysis and each Copilot question |

## 5. Turn on "Import from Gmail" (Google Cloud, free)
1. At **console.cloud.google.com**, create a project, then search for **Gmail API** and click **Enable**.
2. Open **Google Auth Platform** and click **Get started**. Use **External** for the audience. Under **Audience**, add **Test users**: only these people can use the import while the app is in testing.
3. Under **Data Access**, add the scope `https://www.googleapis.com/auth/gmail.readonly`.
4. Under **Clients**, create a **Web application** client with the authorised JavaScript origin `https://TaxMate-ledger.vercel.app`.
5. Put the **Client ID** (public) in `public/js/config.js` as `GOOGLE_CLIENT_ID`. No client secret is needed.

How it works: Google's pop-up asks for read-only access. The browser then searches Gmail directly and downloads only the attachments the user ticks, and the access is revoked straight after. Emails never pass through our server, the database or the AI.
Limitation: Gmail is a "restricted" scope. In testing mode it allows up to 100 listed users, who see a "Google hasn't verified this app" warning. Public release would need Google's verification and a security assessment.

## Updating the site
Every change pushed to GitHub redeploys automatically.

## Security notes
- Never put API keys in the code, the report, the poster or screenshots. They live only in Vercel's environment variables.
- If a key was ever shared, for example in the Capstone 1 "API keys" document, **rotate it**: delete it in the provider's dashboard and make a new one.
