# Apps Dashboard

Central hub for all Alan Ranger tools and applications.

## Purpose

This repository contains a standalone HTML dashboard that provides quick access to all tools and applications created across the Alan Ranger digital ecosystem. It serves as a single entry point for managing and accessing various tools.

## Structure

- `index.html` - Main dashboard page with tiles linking to all tools

## Categories

The dashboard organizes tools into the following categories:

1. **Chat AI Bot** - AI assistant tools, testing, analytics, and data management
2. **Photography Tools** - Exposure calculator, print size calculator, practice pack generator
3. **Workshop & Planning Tools** - Workshop planner and logistics tools
4. **Blog & Website Tools** - Schema generation, blog optimization, CTA generators, checklist generators
5. **SEO & Analytics Tools** - AI GEO Audit dashboard and SEO analysis
6. **Other Tools** - Additional utilities like gardening calculators

## Usage

Simply open `index.html` in a web browser to access the dashboard. All links open in new tabs for easy navigation.

## Deployment

This dashboard can be:
- Hosted as a static site on GitHub Pages
- Deployed to Vercel or similar static hosting
- Served locally for development

## Adding New Tools

To add a new tool to the dashboard:

1. Open `index.html`
2. Find the appropriate section (or create a new one)
3. Add a new tile following the existing pattern:

```html
<a href="YOUR_URL" target="_blank" class="tile">
  <div class="tile-header">
    <div class="tile-icon">ICON_EMOJI</div>
    <div class="tile-title">Tool Name</div>
  </div>
  <div class="tile-description">
    <p>Brief description of what the tool does.</p>
    <p>Additional details about features or usage.</p>
  </div>
  <span class="tile-badge badge-external">External</span>
</a>
```

## Notes

- All tools are currently marked as "External" since they're hosted separately
- The dashboard uses a dark theme consistent with other Alan Ranger tools
- Responsive design works on mobile and desktop
