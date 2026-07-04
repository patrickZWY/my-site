{-# LANGUAGE OverloadedStrings #-}

import Hakyll
import System.FilePath (takeBaseName)

main :: IO ()
main = hakyllWith siteConfig $ do
    match "static/**" $ do
        route $ gsubRoute "static/" (const "")
        compile copyFileCompiler

    match "css/*" $ do
        route idRoute
        compile compressCssCompiler

    match "content/*.md" $ do
        route $ customRoute pageRoute
        compile pageCompiler

    create ["sitemap.xml"] $ do
        route idRoute
        compile $ do
            pages <- filter isSitemapPage <$> loadAll "content/*.md"
            makeItem ("" :: String)
                >>= loadAndApplyTemplate "templates/sitemap.xml" (sitemapContext pages)

    match "templates/*" $ compile templateBodyCompiler

siteConfig :: Configuration
siteConfig = defaultConfiguration
    { destinationDirectory = "_site"
    , storeDirectory = "_cache"
    , tmpDirectory = "_cache/tmp"
    }

pageCompiler :: Compiler (Item String)
pageCompiler =
    pandocCompiler
        >>= loadAndApplyTemplate "templates/default.html" siteContext
        >>= relativizeUrls

siteContext :: Context String
siteContext =
    constField "siteTitle" "Zheng Wangyuan (Patrick)"
        <> constField "siteUrl" "https://zhengwangyuan-patrick.com"
        <> defaultContext

sitemapContext :: [Item String] -> Context String
sitemapContext pages =
    listField "entries" siteContext (return pages)
        <> siteContext

pageRoute :: Identifier -> FilePath
pageRoute identifier =
    case takeBaseName (toFilePath identifier) of
        "index" -> "index.html"
        "404" -> "404.html"
        page -> page <> "/index.html"

isSitemapPage :: Item String -> Bool
isSitemapPage =
    (/= "404") . takeBaseName . toFilePath . itemIdentifier
