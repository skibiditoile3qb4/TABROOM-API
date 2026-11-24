
const express = require("express");
const axios = require("axios");
const qs = require("qs");
const cheerio = require("cheerio");
const cors = require("cors");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const app = express();
const BASE = "https://www.tabroom.com";
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "100kb" }));

function createClient() {
  const jar = new CookieJar();

  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/158.0.0.0 Safari/537.36"
    }
  }));
}

async function login(user, pass) {
  if (!user || !pass) {
    throw new Error("Username and password required");
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

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Tabroom API",
    endpoints: [
      "POST /api/paradigms",
      "POST /api/search",
      "POST /api/tournament",
      "POST /api/tabs",
      "POST /api/events",
      "POST /api/rounds",
      "POST /api/pairings",
      "POST /api/break-rounds"
    ]
  });
});

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

  return parseParadigmPage(response.data);
}

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
function parseParadigmPage(html) {
  const $ = cheerio.load(html);

  const name = $(".main > h3").first().text().trim();

  const lastReviewed = $(".screens.paradigm .rightalign")
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim();

  const paradigmContainer = $(".screens.paradigm > .paradigm").first();
  const paragraphs = paradigmContainer
    .find("p")
    .map((_, el) => {
      const html = $(el).html() || "";

      return cheerio
        .load(`<div>${html.replace(/<br\s*\/?>/gi, "\n")}</div>`)("div")
        .text()
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim();
    })
    .get()
    .filter(text => text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text));

  return {
    name,
    lastReviewed,
    paradigm: paragraphs.join("\n\n")
  };
}
async function searchTournaments(search) {
  const response = await axios.get(
    `${BASE}/index/search.mhtml`,
    {
      params: { search },
      timeout: 20000
    }
  );

  const $ = cheerio.load(response.data);
  const results = [];

  $("tbody tr").each((_, row) => {
    const cols = $(row).find("td");

    if (cols.length < 4) return;

    const link = $(cols[0]).find("a").first();
    const href = link.attr("href");

    if (!href) return;

    const id = new URL(href, BASE)
      .searchParams.get("tourn_id");

    results.push({
      name: link.text().trim(),
      id,
      region: $(cols[1]).text().trim(),
      date: $(cols[2]).text().trim(),
      circuit: $(cols[3]).text().trim()
    });
  });

  return results;
}

app.post("/api/search", async (req, res) => {
  try {
    const { search } = req.body;

    if (!search) {
      return res.status(400).json({
        error: "Missing search"
      });
    }

    res.json(await searchTournaments(search));
  } catch (error) {
    res.status(500).json({
      error: "Tournament search failed",
      details: error.message
    });
  }
});


async function getTournament(id) {
  const response = await axios.get(
    `${BASE}/index/tourn/index.mhtml`,
    {
      params: { tourn_id: id }
    }
  );

  const $ = cheerio.load(response.data);

  return {
    meta: $("h5").text().trim()
      .replace(/\n/g, "")
      .replace(/\t/g, " "),
    name: $("h2").first().text().trim()
  };
}

app.post("/api/tournament", async (req, res) => {
  try {
    const { tournamentId } = req.body;

    if (!tournamentId) {
      return res.status(400).json({
        error: "Missing tournamentId"
      });
    }

    res.json(await getTournament(tournamentId));
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

async function getTabs(id) {
  const response = await axios.get(
    `${BASE}/index/tourn/index.mhtml`,
    {
      params: { tourn_id: id }
    }
  );

  const $ = cheerio.load(response.data);
  const tabs = [];

  $("#tabnav").children().each((_, li) => {
    const name = $(li).find("a").first().text().trim();

    if (name) tabs.push(name);
  });

  return tabs;
}

app.post("/api/tabs", async (req, res) => {
  try {
    const { tournamentId } = req.body;

    if (!tournamentId) {
      return res.status(400).json({
        error: "Missing tournamentId"
      });
    }

    res.json(await getTabs(tournamentId));
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

async function fetchEvents(id) {
  const response = await axios.get(
    `${BASE}/index/tourn/fields.mhtml`,
    {
      params: { tourn_id: id }
    }
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

app.post("/api/events", async (req, res) => {
  try {
    const { tournamentId } = req.body;

    if (!tournamentId) {
      return res.status(400).json({
        error: "Missing tournamentId"
      });
    }

    res.json(await fetchEvents(tournamentId));
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});


async function getRounds(tournament, event) {
  const response = await axios.post(
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
        roundName: $(element).text().trim()
          .replace(/\s+/g, " "),
        roundID
      });
    }
  });

  return rounds;
}

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
    res.status(500).json({
      error: error.message
    });
  }
});


async function getPairings(tournament, round) {
  const response = await axios.get(
    `${BASE}/index/tourn/postings/round.mhtml`,
    {
      params: {
        tourn_id: tournament,
        round_id: round
      }
    }
  );

  const $ = cheerio.load(response.data);

  const headers = $("thead > tr > th")
    .map((_, element) => $(element).text().trim())
    .get();

  const results = [];

  $("tbody > tr").each((_, row) => {
    const item = {};

    $(row).find("td").each((index, cell) => {
      const link = $(cell).find("a").first();
      let id = null;

      if (link.attr("href")) {
        const parsed = new URL(link.attr("href"), BASE);

        for (const [key, value] of parsed.searchParams) {
          if (key !== "tourn_id") {
            id = value;
            break;
          }
        }
      }

      item[headers[index] || `column_${index}`] = {
        name: $(cell).text().trim()
          .replace(/\s+/g, " "),
        id
      };
    });

    if (Object.keys(item).length) {
      results.push(item);
    }
  });

  return results;
}

app.post("/api/pairings", async (req, res) => {
  try {
    const { tournamentId, roundId } = req.body;

    if (!tournamentId || !roundId) {
      return res.status(400).json({
        error: "Missing tournamentId or roundId"
      });
    }

    res.json(await getPairings(tournamentId, roundId));
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});


function isBreakRound(name) {
  return /octo|quarter|semi.?final|grand final|finals?|elimination|elim|break|runoff|round of\s+\d+/i.test(name);
}

async function fetchBreakRounds(tournament, eventID = null) {
  const tournamentInfo = await getTournament(tournament);

  const events = eventID
    ? [{
        eventID,
        eventName: "Selected event"
      }]
    : await fetchEvents(tournament);

  const results = [];

  for (const event of events) {
    const rounds = await getRounds(
      tournament,
      event.eventID
    );

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

app.post("/api/break-rounds", async (req, res) => {
  try {
    const { tournamentId, eventId } = req.body;

    if (!tournamentId) {
      return res.status(400).json({
        error: "Missing tournamentId"
      });
    }

    res.json(
      await fetchBreakRounds(
        tournamentId,
        eventId || null
      )
    );
  } catch (error) {
    res.status(500).json({
      error: "Could not fetch break rounds",
      details: error.message
    });
  }
});
app.listen(PORT, () => {
  console.log(`Tabroom API running on port ${PORT}`);
});
