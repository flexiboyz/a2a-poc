# Next.js App

This is the Next.js frontend application for the a2a-poc project.

## Getting Started

First, install dependencies:

```bash
cd nextjs-app
npm install
```

Then, run the development server:

```bash
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) with your browser to see the result.

> **Note:** The dev server runs on port **3001** to avoid conflicts with the Express backend server on port 3000.

## Project Structure

This project uses the Next.js App Router with the following structure:

- `src/app/` — App Router pages and layouts
- `src/app/globals.css` — Global styles with Tailwind CSS
- `public/` — Static assets
- `next.config.ts` — Next.js configuration
- `tailwind.config.ts` — Tailwind CSS configuration

## Relationship to Backend

This Next.js app is a separate project within the a2a-poc repository. It has its own:
- `package.json` and `node_modules/`
- `tsconfig.json`
- Build and dev scripts

The Express backend (`src/server.ts` at the repo root) and this Next.js app are managed independently.
