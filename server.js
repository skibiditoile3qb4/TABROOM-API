
const express = require("express");
const axios = require("axios");
const qs = require("qs");
const cheerio = require("cheerio");
const cors = require("cors");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const BASE = "https://www.tabroom.com";

function createClient() {
  const jar = new CookieJar();

  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 30000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": BASE
    }
  }));
}

async function login(username, password) {
  if (!username || !password) {
    throw new Error("Tabroom username and password are required");
  }

  const client = createClient();

  await client.post(
    `${BASE}/user/login/login_save.mhtml`,
    qs.stringify({
      maxRedirects: 0,
      username,
      password
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `${BASE}/user/login/`
      },
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    }
  );

  return client;
}

function checkLogin(html) {
  const $ = cheerio.load(html);
  const text = $("body").text();

  if (
    text.includes("Login to Tabroom") ||
    text.includes("Forgot your Password?")
  ) {
    throw new Error("Tabroom authentication failed");
  }
}

async function getTournament(client, id) {
  const r = await client.get(
    `${BASE}/index/tourn/index.mhtml?tourn_id=${encodeURIComponent(id)}`
  );

  checkLogin(r.data);

  const $ = cheerio.load(r.data);

  return {
    meta: $("h5").first().text().trim(),
    name: $("h2").first().text().trim()
  };
}

async function searchTournaments(search) {
  const r = await axios.get(`${BASE}/index/search.mhtml`, {
    params: { search }
  });

  const $ = cheerio.load(r.data);
  const tournaments = [];

  $("table tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (!cells.length) return;

    const link = $(cells[0]).find("a").first();
    const href = link.attr("href") || "";
    const id = href.match(/tourn_id=(\d+)/)?.[1];

    tournaments.push({
      name: link.text().trim() || $(cells[0]).text().trim(),
      id,
      region: $(cells[1]).text().trim(),
      date: $(cells[2]).text().trim(),
      circuit: $(cells[3]).text().trim()
    });
  });

  return tournaments;
}

async function getTabs(client, id) {
  const r = await client.get(
    `${BASE}/index/tourn/index.mhtml?tourn_id=${encodeURIComponent(id)}`
  );

  checkLogin(r.data);

  const $ = cheerio.load(r.data);
  const tabs = [];

  $("#tabnav a, #tabnav li").each((_, el) => {
    const link = $(el).is("a") ? $(el) : $(el).find("a").first();

    tabs.push({
      name: $(el).text().trim(),
      href: link.attr("href") || null
    });
  });

  return tabs.filter(tab => tab.name);
}

async function fetchEvents(client, id) {
  const r = await client.get(
    `${BASE}/index/tourn/fields.mhtml?tourn_id=${encodeURIComponent(id)}`
  );

  checkLogin(r.data);

  const $ = cheerio.load(r.data);
  const events = [];

  $(".sidenote a").each((_, el) => {
    const href = $(el).attr("href") || "";
    const eventId = href.match(/event_id=(\d+)/)?.[1];

    if (eventId) {
      events.push({
        name: $(el).text().trim(),
        id: eventId,
        href
      });
    }
  });

  return events;
}

async function getRounds(client, tournamentId, eventId) {
  const r = await client.post(
    `${BASE}/index/tourn/postings/index.mhtml`,
    qs.stringify({
      tourn_id: tournamentId,
      event_id: eventId
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  checkLogin(r.data);

  const $ = cheerio.load(r.data);
  const rounds = [];

  $(".sidenote a").each((_, el) => {
    const href = $(el).attr("href") || "";
    const roundId = href.match(/round_id=(\d+)/)?.[1];

    if (roundId) {
      rounds.push({
        name: $(el).text().trim(),
        id: roundId,
        href
      });
    }
  });

  return rounds;
}

async function getPairings(client, tournamentId, roundId) {
  const r = await client.get(
    `${BASE}/index/tourn/postings/round.mhtml`,
    {
      params: {
        tourn_id: tournamentId,
        round_id: roundId
      }
    }
  );

  checkLogin(r.data);

  const $ = cheerio.load(r.data);
  const headings = [];

  $("table thead tr").first().find("th").each((_, el) => {
    headings.push($(el).text().trim());
  });

  const pairings = [];

  $("table tbody tr").each((_, row) => {
    const cells = [];

    $(row).find("td").each((_, cell) => {
      cells.push({
        text: $(cell).text().trim(),
        links: $(cell).find("a").map((_, a) => ({
          text: $(a).text().trim(),
          href: $(a).attr("href")
        })).get()
      });
    });

    if (cells.length) pairings.push(cells);
  });

  return { headings, pairings };
}

async function fetchBreakRounds(client, tournamentId, eventId) {
  const events = eventId
    ? [{ id: eventId, name: "" }]
    : await fetchEvents(client, tournamentId);

  const results = [];

  const breakPattern =
    /octo|quarter|semi.?final|grand final|finals?|elimination|elim|break|runoff|round of\s+\d+/i;

  for (const event of events) {
    const rounds = await getRounds(client, tournamentId, event.id);

    results.push({
      event: event.name,
      eventId: event.id,
      rounds: rounds.filter(round => breakPattern.test(round.name))
    });
  }

  return results;
}

async function fetchParadigms(client, first, last) {
  const r = await client.post(
    `${BASE}/index/paradigm.mhtml`,
    qs.stringify({
      search_first: first,
      search_last: last
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `${BASE}/index/paradigm.mhtml`
      }
    }
  );

  checkLogin(r.data);

  const $ = cheerio.load(r.data);

  return {
    name: $(".main h3").first().text().trim(),
    lastReviewed: $(".screens.paradigm .rightalign").first().text().trim(),
    paradigm: $(".screens.paradigm .paradigm").first().text().trim(),
    html: r.data
  };
}

async function authenticated(req, res, action) {
  try {
    const client = await login(
      req.body.username,
      req.body.password
    );

    const result = await action(client);

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message || "Request failed"
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    endpoints: [
      "/api/paradigms",
      "/api/search",
      "/api/tournament",
      "/api/tabs",
      "/api/events",
      "/api/rounds",
      "/api/pairings",
      "/api/break-rounds"
    ]
  });
});

app.post("/api/paradigms", (req, res) => {
  authenticated(req, res, client =>
    fetchParadigms(
      client,
      req.body.search_first,
      req.body.search_last
    )
  );
});

app.post("/api/search", async (req, res) => {
  try {
    res.json(await searchTournaments(req.body.search));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tournament", (req, res) => {
  authenticated(req, res, client =>
    getTournament(client, req.body.tournamentId)
  );
});

app.post("/api/tabs", (req, res) => {
  authenticated(req, res, client =>
    getTabs(client, req.body.tournamentId)
  );
});

app.post("/api/events", (req, res) => {
  authenticated(req, res, client =>
    fetchEvents(client, req.body.tournamentId)
  );
});

app.post("/api/rounds", (req, res) => {
  authenticated(req, res, client =>
    getRounds(
      client,
      req.body.tournamentId,
      req.body.eventId
    )
  );
});

app.post("/api/pairings", (req, res) => {
  authenticated(req, res, client =>
    getPairings(
      client,
      req.body.tournamentId,
      req.body.roundId
    )
  );
});

app.post("/api/break-rounds", (req, res) => {
  authenticated(req, res, client =>
    fetchBreakRounds(
      client,
      req.body.tournamentId,
      req.body.eventId
    )
  );
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Tabroom API running on port ${PORT}`);
});
