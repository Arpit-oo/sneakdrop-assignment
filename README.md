> ## Submission
> - **Live demo:** https://sneakdrop-3otn.onrender.com/?user=alice (open a 2nd tab as `?user=bob`; free tier, first load after idle can take ~30 s)
> - **Video walkthrough:** https://www.loom.com/share/70c841858cf5465ca173fe9fdd4c3f70
> - **How to run, design and trade-offs:** [NOTES.md](NOTES.md)
> - **One-command start:** `docker compose up --build` → http://localhost:3000/?user=alice
> - **Tests:** `npm test` (98 integration tests on real Postgres) · `npm run load` (5,000 buyers, invariant checks) · CI on every push
>
> The original assignment brief follows.

---

# Sneaker Drop

A small shoe brand is launching one limited sneaker. They only have 20 pairs. When the sale opens, thousands of people will click Buy at the same second.

Last time, their website sold 51 pairs when they only had 20, and they had to refund 31 people. Your job is to build the full system for the next sale so this never happens again.

## The rules

1. When a user clicks Buy, one pair is held for them for 5 minutes. If they don't pay in time, the pair goes back to stock.
2. A user can hold only 1 pair at a time, and can buy a maximum of 2 pairs in total.
3. If stock is 0, users can join a waiting line. When someone's hold runs out, the first person in line automatically gets that pair, with their own 5 minutes.
4. Payments are fake. You don't need to build a real payment system, just make your own simple fake one that sends your app a "payment succeeded" message, like a real payment company would. Real ones are messy, so sometimes the message comes late, sometimes twice, sometimes in the wrong order.
5. One page shows the pairs left, the user's hold countdown, and their place in the waiting line. It doesn't need to look good, plain text is fine.

Use any language or tools you are comfortable with.

## What you send back

1. Your code (repo or zip)
2. A NOTES.md file that tells how to run the project, and any other requirements that are needed
3. A screen recording (Loom or any tool you like) where you explain your project

Please fork this repo and build your project in your fork.
