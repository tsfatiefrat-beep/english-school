# English School: קבצים ל־Netlify עם בוט Gemini

בתיקייה:
- index.html: המשחק
- netlify.toml: הגדרות ל־Netlify
- netlify/functions/bot.mjs: הבוט שמדבר עם Gemini. המפתח נשמר בשרת ולא נחשף.

המפתח של Gemini נשמר רק ב־Netlify, תחת Environment variables, בשם GEMINI_API_KEY.
לעולם לא כותבים אותו בתוך הקבצים.

עדכון המשחק בעתיד: מעלים ל־GitHub קובץ index.html חדש, ו־Netlify מתעדכן לבד.
