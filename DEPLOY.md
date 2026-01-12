# Deployment Instructions

## Push to GitHub

After creating a new repository on GitHub (e.g., `apps-dashboard`), run:

```bash
cd "g:\Dropbox\alan ranger photography\Website Code\apps-dashboard"
git remote add origin https://github.com/alanranger/apps-dashboard.git
git push -u origin main
```

(Replace `alanranger/apps-dashboard` with your actual GitHub username and repo name)

## Enable GitHub Pages

1. Go to your repository on GitHub
2. Click **Settings** → **Pages**
3. Under **Source**, select:
   - **Branch**: `main`
   - **Folder**: `/ (root)`
4. Click **Save**

Your dashboard will be available at:
`https://YOUR_USERNAME.github.io/apps-dashboard/`

## Automatic Deployment

The repository includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that will automatically deploy to GitHub Pages whenever you push to the `main` branch.

## Custom Domain (Optional)

If you want to use a custom domain:
1. Add a `CNAME` file in the root with your domain name
2. Configure DNS settings as instructed by GitHub Pages
