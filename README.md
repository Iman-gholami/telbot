# Narges Koochooloo Telegram Bot V4

یک بات تلگرام فارسی برای گروه دوستانه که مثل عضو گروه رفتار می‌کند، حافظه‌ی بلندمدت محدود به «مهندس» و «خانوم دکتر» دارد، در بحث‌ها به‌صورت کنترل‌شده وارد می‌شود و برای سؤال‌های واقعی از حالت شوخی خارج می‌شود.

## قابلیت‌های اصلی

- fallback خودکار بین چند مدل رایگان OpenRouter و `openai/gpt-5-nano` به‌عنوان fallback پولی نهایی
- سقف محلی هزینه ماهانه (پیش‌فرض: 1 دلار)
- سرچ وب فقط برای سؤال‌های وابسته به اطلاعات تازه
- حافظه هوشمند با add/update/remove و خلاصه‌ی rolling گفتگو
- ورود خودکار متوسط با debounce و cooldown
- پنل `/settings` برای ادمین
- `/status` برای مدل، 429، هزینه، دیتابیس و uptime
- فقط متن؛ عکس/ویس به‌عنوان placeholder در تاریخچه ثبت می‌شوند و تحلیل محتوایی نمی‌شوند

## نصب

Node.js 20+ لازم است؛ Node 22 LTS پیشنهاد می‌شود.

```bash
npm install
cp .env.example .env
# .env را تکمیل کنید
npm start
```

اگر `better-sqlite3` نیاز به build محلی داشت:

```bash
sudo apt update
sudo apt install -y build-essential python3
npm install
```

## متغیرهای مهم

حداقل این‌ها را در `.env` تنظیم کنید:

```env
BOT_TOKEN=...
OPENROUTER_API_KEY=...
ENGINEER_ID=...
DOCTOR_ID=...
```

اگر `ADMIN_IDS` خالی باشد، `ENGINEER_ID` ادمین پنل در نظر گرفته می‌شود.

برای استفاده از auto-discovery مدل‌های رایگان، `AI_MODELS` را خالی بگذارید. fallback پولی فقط برای درخواست مستقیم استفاده می‌شود و کارهای background/ورود خودکار از بودجه پولی مصرف نمی‌کنند.
