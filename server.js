const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

// --- Environment ---
if (!process.env.DATABASE_URL) {
  console.error(
    "FATAL: DATABASE_URL is not set. Please provide a PostgreSQL connection string in process.env.DATABASE_URL."
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const prisma = new PrismaClient();
const app = express();

// --- View engine ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// --- Middleware ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  session({
    secret: "gym_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);

// --- Default admin ---
async function ensureDefaultAdmin() {
  const email = "admin@gym.com";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const hashed = await bcrypt.hash("123456", 10);
    await prisma.user.create({
      data: { name: "Administrator", email, password: hashed, role: "admin" },
    });
    console.log("Default admin created -> admin@gym.com / 123456");
  }
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect("/login");
}

// --- Helpers ---
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days));
  return d;
}

// --- Auth routes ---
app.get("/", (req, res) => res.redirect("/app"));

app.get("/login", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/app");
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email || "" } });
    if (!user) {
      return res.render("login", { error: "Invalid email or password" });
    }
    const ok = await bcrypt.compare(password || "", user.password);
    if (!ok) {
      return res.render("login", { error: "Invalid email or password" });
    }
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    };
    res.redirect("/app");
  } catch (err) {
    console.error(err);
    res.render("login", { error: "Something went wrong. Try again." });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// --- Shared app handler (GET + POST) ---
async function appHandler(req, res) {
  try {
    const page = req.query.page || req.body.page || "dashboard";
    const user = req.session.user;
    let success_msg = req.query.success_msg || null;

    // --- Handle deletes via query params ---
    if (req.query.delete_member) {
      await prisma.member.delete({
        where: { id: Number(req.query.delete_member) },
      });
      return res.redirect(
        `/app?page=members&success_msg=${encodeURIComponent("Member deleted")}`
      );
    }
    if (req.query.delete_plan) {
      await prisma.plan.delete({
        where: { id: Number(req.query.delete_plan) },
      });
      return res.redirect(
        `/app?page=plans&success_msg=${encodeURIComponent("Plan deleted")}`
      );
    }
    if (req.query.delete_trainer) {
      await prisma.trainer.delete({
        where: { id: Number(req.query.delete_trainer) },
      });
      return res.redirect(
        `/app?page=trainers&success_msg=${encodeURIComponent("Trainer deleted")}`
      );
    }

    // --- Handle POST actions ---
    if (req.method === "POST" && req.body.action) {
      const action = req.body.action;

      if (action === "add_member") {
        const count = await prisma.member.count();
        const membership_id = "GM" + String(1000 + count + 1);
        await prisma.member.create({
          data: {
            membership_id,
            first_name: req.body.first_name,
            last_name: req.body.last_name,
            phone: req.body.phone || null,
            email: req.body.email || null,
            gender: req.body.gender || null,
            status: req.body.status || "active",
          },
        });
        return res.redirect(
          `/app?page=members&success_msg=${encodeURIComponent("Member added")}`
        );
      }

      if (action === "add_plan") {
        await prisma.plan.create({
          data: {
            name: req.body.name,
            duration_days: Number(req.body.duration_days),
            price: parseFloat(req.body.price),
          },
        });
        return res.redirect(
          `/app?page=plans&success_msg=${encodeURIComponent("Plan added")}`
        );
      }

      if (action === "assign_plan") {
        const plan = await prisma.plan.findUnique({
          where: { id: Number(req.body.plan_id) },
        });
        const start = new Date();
        const end = addDays(start, plan ? plan.duration_days : 30);
        await prisma.subscription.create({
          data: {
            member_id: Number(req.body.member_id),
            plan_id: Number(req.body.plan_id),
            start_date: start,
            end_date: end,
            status: "active",
          },
        });
        return res.redirect(
          `/app?page=members&success_msg=${encodeURIComponent("Plan assigned")}`
        );
      }

      if (action === "add_payment") {
        const payment = await prisma.payment.create({
          data: {
            member_id: Number(req.body.member_id),
            subscription_id: req.body.subscription_id
              ? Number(req.body.subscription_id)
              : null,
            amount: parseFloat(req.body.amount),
            payment_method: req.body.payment_method || "cash",
          },
        });
        const invCount = await prisma.invoice.count();
        await prisma.invoice.create({
          data: {
            member_id: payment.member_id,
            payment_id: payment.id,
            invoice_number: "INV" + String(1000 + invCount + 1),
            total_amount: payment.amount,
          },
        });
        return res.redirect(
          `/app?page=payments&success_msg=${encodeURIComponent("Payment recorded")}`
        );
      }

      if (action === "checkin_member") {
        await prisma.attendance.create({
          data: { member_id: Number(req.body.member_id) },
        });
        return res.redirect(
          `/app?page=attendance&success_msg=${encodeURIComponent("Checked in")}`
        );
      }

      if (action === "checkout_member") {
        const open = await prisma.attendance.findFirst({
          where: { member_id: Number(req.body.member_id), check_out: null },
          orderBy: { check_in: "desc" },
        });
        if (open) {
          await prisma.attendance.update({
            where: { id: open.id },
            data: { check_out: new Date() },
          });
        }
        return res.redirect(
          `/app?page=attendance&success_msg=${encodeURIComponent("Checked out")}`
        );
      }

      if (action === "add_trainer") {
        await prisma.trainer.create({
          data: {
            name: req.body.name,
            phone: req.body.phone || null,
            specialization: req.body.specialization || null,
          },
        });
        return res.redirect(
          `/app?page=trainers&success_msg=${encodeURIComponent("Trainer added")}`
        );
      }

      if (action === "assign_trainer") {
        await prisma.memberTrainer.create({
          data: {
            member_id: Number(req.body.member_id),
            trainer_id: Number(req.body.trainer_id),
          },
        });
        return res.redirect(
          `/app?page=trainers&success_msg=${encodeURIComponent("Trainer assigned")}`
        );
      }
    }

    // --- Always fetch shared data ---
    const members = await prisma.member.findMany({ orderBy: { id: "desc" } });
    const plans = await prisma.plan.findMany({ orderBy: { id: "desc" } });
    const trainers = await prisma.trainer.findMany({ orderBy: { id: "desc" } });

    const data = {
      page,
      user,
      success_msg,
      members,
      plans,
      trainers,
      // page-specific below
      stats: null,
      payments: [],
      attendance: [],
      memberTrainers: [],
    };

    // --- Page specific data ---
    if (page === "dashboard") {
      const total_members = await prisma.member.count();
      const active_members = await prisma.member.count({
        where: { status: "active" },
      });
      const revenueAgg = await prisma.payment.aggregate({
        _sum: { amount: true },
      });
      data.stats = {
        total_members,
        active_members,
        total_revenue: revenueAgg._sum.amount || 0,
      };
    }

    if (page === "payments") {
      data.payments = await prisma.payment.findMany({
        orderBy: { id: "desc" },
        include: { member: true },
      });
    }

    if (page === "attendance") {
      data.attendance = await prisma.attendance.findMany({
        orderBy: { id: "desc" },
        include: { member: true },
        take: 100,
      });
    }

    if (page === "trainers") {
      data.memberTrainers = await prisma.memberTrainer.findMany({
        orderBy: { id: "desc" },
        include: { member: true, trainer: true },
      });
    }

    res.render("app", data);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error: " + err.message);
  }
}

app.get("/app", requireAuth, appHandler);
app.post("/app", requireAuth, appHandler);

// --- 404 ---
app.use((req, res) => res.status(404).send("Route Not Found"));

// --- Start ---
ensureDefaultAdmin()
  .catch((e) => console.error("Admin init error:", e))
  .finally(() => {
    app.listen(PORT, "0.0.0.0", () =>
      console.log(`Gym Management System running on port ${PORT}`)
    );
  });
