import { Router, type IRouter } from "express";
import healthRouter from "./health";
import collectionRouter from "./collection";
import cardsRouter from "./cards";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/collection", collectionRouter);
router.use("/cards", cardsRouter);

export default router;
