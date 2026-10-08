-- 014_research_feed_topics.sql
--
-- Research Feed "By approach" tabs: Protocols, Yoga, Meditation, TCM, Fasting, Diet.
--
-- These are a different KIND of category from the five pillars (research_feed_item_pillars). A pillar is a root
-- cause tracked on the dashboard (en/rf/ft/md/sl, closed set, matching the dashboard exactly, enforced by migration
-- 008's CHECK). An approach is HOW someone addresses health: a practice or a way of eating. Mixing them into the
-- pillar table would break that CHECK and the page's own statement that its tabs are "the same five pillars tracked
-- on your dashboard". So approaches get their own junction table with their own closed set.
--
-- An item can carry pillars, approaches, or both, but at least one of the two (enforced in the controller, since it
-- spans two tables). The six ids are in the CHECK so a typo can never become a tab nobody can reach; adding a seventh
-- approach later is one new migration plus one line in the page and the admin form (the guard test cross-checks them).

CREATE TABLE research_feed_item_topics (
    item_id  UUID NOT NULL REFERENCES research_feed_items(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL CHECK (topic_id IN ('protocols','yoga','meditation','tcm','fasting','diet')),
    PRIMARY KEY (item_id, topic_id)
);
CREATE INDEX idx_research_feed_item_topics_topic ON research_feed_item_topics(topic_id);
