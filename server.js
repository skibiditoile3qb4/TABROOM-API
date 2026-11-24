const express = require("express");
const axios = require("axios");
const qs = require("qs");
const cheerio = require("cheerio");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const app = express();
app.use(express.json({ limit: "100kb" }));

const BASE = "https://www.tabroom.com";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/158.0.0.0 Safari/537.36";

function createClient() {
  const jar = new CookieJar();

  return wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    })
  );
}

async function login(user, pass) {
  if (!user || !pass) {
    throw new Error("Username and password are required");
  }

  const client = createClient();

  await client.post(
    `${BASE}/user/login/login_save.mhtml`,
    qs.stringify({
      maxRedirects: 0,
      username: user,
      password: pass
    }),
    {
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: BASE,
        Referer: `${BASE}/user/login/login.mhtml`
      }
    }
  );

  return client;
}


async function fetchParadigms(user, pass, first, last) {
  const client = await login(user, pass);

  const response = await client.post(
    `${BASE}/index/paradigm.mhtml`,
    qs.stringify({
      search_first: first || "",
      search_last: last || ""
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: BASE,
        Referer: `${BASE}/index/paradigm.mhtml`
      }
    }
  );

  const $ = cheerio.load(response.data);

  return {
    title: $("title").text().trim(),
    text: $("body").text().replace(/\s+/g, " ").trim(),
    html: response.data
  };
}

async function getTournament(id) {
  const client = createClient();

  const response = await client.get(
    `${BASE}/index/tourn/index.mhtml`,
    { params: { tourn_id: id } }
  );

  const $ = cheerio.load(response.data);

  return {
    meta: $("h5").text().trim().replace(/\n/g, "").replace(/\t/g, " "),
    name: $("h2").first().text().trim()
  };
}

async function getTabs(id) {
  const client = createClient();

  const response = await client.get(
    `${BASE}/index/tourn/index.mhtml`,
    { params: { tourn_id: id } }
  );

  const $ = cheerio.load(response.data);
  const tabs = [];

  $("#tabnav").children().each((_, li) => {
    const name = $(li).find("a").first().text().trim();

    if (name) tabs.push(name);
  });

  return tabs;
}

async function fetchEvents(id) {
  const client = createClient();

  const response = await client.get(
    `${BASE}/index/tourn/fields.mhtml`,
    { params: { tourn_id: id } }
  );

  const $ = cheerio.load(response.data);
  const events = [];

  $(".sidenote a").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    const parsed = new URL(href, BASE);
    const eventID = parsed.searchParams.get("event_id");

    if (eventID) {
      events.push({
        eventName: $(element).text().trim(),
        eventID
      });
    }
  });

  return events;
}

async function getRounds(tournament, event) {
  const client = createClient();

  const response = await client.post(
    `${BASE}/index/tourn/postings/index.mhtml`,
    qs.stringify({
      tourn_id: tournament,
      event_id: event
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  const $ = cheerio.load(response.data);
  const rounds = [];

  $(".sidenote a").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    const parsed = new URL(href, BASE);
    const roundID = parsed.searchParams.get("round_id");

    if (roundID) {
      rounds.push({
        roundName: $(element).text().trim().replace(/\s+/g, " "),
        roundID
      });
    }
  });

  return rounds;
}

function isBreakRound(name) {
  return /octo|quarter|semi.?final|grand final|finals?|elimination|elim|break|runoff|round of\s+\d+/i.test(name);
}

async function fetchBreakRounds(tournament, eventID = null) {
  const tournamentInfo = await getTournament(tournament);

  const events = eventID
    ? [{ eventID, eventName: "Selected event" }]
    : await fetchEvents(tournament);

  const results = [];

  for (const event of events) {
    const rounds = await getRounds(tournament, event.eventID);

    results.push({
      eventName: event.eventName,
      eventID: event.eventID,
      breakRounds: rounds.filter(round =>
        isBreakRound(round.roundName)
      ),
      allRounds: rounds
    });
  }

  return {
    tournamentID: tournament,
    tournament: tournamentInfo,
    events: results
  };
}

//routes

app.post("/api/paradigms", async (req, res) => {
  try {
    const {
      username,
      password,
      search_first,
      search_last
    } = req.body;

    const result = await fetchParadigms(
      username,
      password,
      search_first,
      search_last
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Could not fetch paradigms",
      details: error.message
    });
  }
});

app.post("/api/tournament", async (req, res) => {
  try {
    const { tournamentId } = req.body;

    if (!tournamentId) {
      return res.status(400).json({ error: "Missing tournamentId" });
    }

    res.json(await getTournament(tournamentId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events", async (req, res) => {
  try {
    const { tournamentId } = req.body;

    if (!tournamentId) {
      return res.status(400).json({ error: "Missing tournamentId" });
    }

    res.json(await fetchEvents(tournamentId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/rounds", async (req, res) => {
  try {
    const { tournamentId, eventId } = req.body;

    if (!tournamentId || !eventId) {
      return res.status(400).json({
        error: "Missing tournamentId or eventId"
      });
    }

    res.json(await getRounds(tournamentId, eventId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/break-rounds", async (req, res) => {
  try {
    const { tournamentId, eventId } = req.body;

    if (!tournamentId) {
      return res.status(400).json({ error: "Missing tournamentId" });
    }

    res.json(await fetchBreakRounds(tournamentId, eventId || null));
  } catch (error) {
    res.status(500).json({
      error: "Could not fetch break rounds",
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Running`);
});
