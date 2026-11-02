# Deploying Luminara Ledger (free)

You need two free accounts: **GitHub**, which stores the code, and **Vercel**, which hosts the website. A **Groq** key is optional; it turns on the cloud AI.

## 1. Put the code on GitHub
1. Create a private repository called `luminara-ledger`.
2. Upload the project files, keeping the folder structure.

## 2. Publish with Vercel
1. Go to **vercel.com** and choose **Sign up**, then **Continue with GitHub**. Pick the free **Hobby** plan.
2. Click **Add New... → Project**, then **Import** next to `luminara-ledger`.
3. Leave the settings as they are. Framework Preset is **Other**, and there's no build command.
4. Click **Deploy**. About 30 seconds later you get a link like `luminara-ledger-xxxx.vercel.app`.

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

## Updating the site
Every change pushed to GitHub redeploys automatically.

## Security notes
- Never put API keys in the code, the report, the poster or screenshots. They live only in Vercel's environment variables.
- If a key was ever shared, for example in the Capstone 1 "API keys" document, **rotate it**: delete it in the provider's dashboard and make a new one.
