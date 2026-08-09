import { Router, type IRouter } from "express";
import healthRouter from "./health";
import collectionRouter from "./collection";
import cardsRouter from "./cards";
import posRouter from "./pos";
import paymentsRouter from "./payments";
import authRouter from "./auth";
import auditRouter from "./audit";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/collection", collectionRouter);
router.use("/cards", cardsRouter);
router.use("/pos", posRouter);
router.use("/payments", paymentsRouter);
router.use("/audit", auditRouter);

export default router;
