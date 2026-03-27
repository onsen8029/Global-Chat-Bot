import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/ping", (_req, res) => {
  res.send("Bot alive");
});

export default router;
