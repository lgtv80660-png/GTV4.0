import { NextResponse } from "next/server";


const FALLBACK_MOVIES = [
  {
    id: 550,
    title: "Fight Club",
    overview: "Un employé de bureau insomniaque et un fabriqueur de savon insouciant forment un club de combat clandestin.",
    backdrop_path: "https://image.tmdb.org/t/p/original/hZ2A3AI9o23Y337C4.jpg",
    poster_path: "https://image.tmdb.org/t/p/w500/pB8L2sIqK484o90458a221.jpg",
  },
  {
    id: 157336,
    title: "Interstellar",
    overview: "Une équipe d'explorateurs voyage à travers un trou de ver dans l'espace pour assurer la survie de l'humanité.",
    backdrop_path: "https://image.tmdb.org/t/p/original/r2J02Z2OpNTL421A26s3fAOfS41.jpg",
    poster_path: "https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
  },
  {
    id: 27205,
    title: "Inception",
    overview: "Un voleur qui s'approprie des secrets d'entreprise à travers la technologie de partage de rêves se voit offrir une chance de retrouver sa vie.",
    backdrop_path: "https://image.tmdb.org/t/p/original/oYuLE1311o2R3B2129328.jpg",
    poster_path: "https://image.tmdb.org/t/p/w500/9gkL2sIqK484o90458a221.jpg",
  },
  {
    id: 155,
    title: "The Dark Knight",
    overview: "Batman relève le défi face au Joker, un criminel sadique qui plonge Gotham City dans le chaos.",
    backdrop_path: "https://image.tmdb.org/t/p/original/nMK2812781.jpg",
    poster_path: "https://image.tmdb.org/t/p/w500/q6y0Go1tsGEmtFryDOlsR3RzPe3.jpg",
  },
];

export async function GET() {
  const apiKey=process.env.TMDB_API_KEY;
  if(!apiKey)return NextResponse.json({movies:FALLBACK_MOVIES},{headers:{'X-GTV-Metadata-Source':'fallback','X-GTV-Metadata-Failure':'not-configured','Cache-Control':'no-store'}});
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/trending/all/week?api_key=${encodeURIComponent(apiKey)}&language=fr-FR&page=1`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!res.ok) {
      return NextResponse.json({ movies: FALLBACK_MOVIES }, { status: 200,headers:{'X-GTV-Metadata-Source':'fallback','X-GTV-Metadata-Failure':'http-'+res.status,'Cache-Control':'no-store'} });
    }

    const data = await res.json();

    const movies = (data.results || [])
      .filter((item: any) => item && item.backdrop_path && item.poster_path)
      .map((item: any) => ({
        id: item.id,
        title: item.title || item.name || "Titre inconnu",
        overview: item.overview || "",
        backdrop_path: item.backdrop_path.startsWith("http")
          ? item.backdrop_path
          : `https://image.tmdb.org/t/p/original${item.backdrop_path}`,
        poster_path: item.poster_path.startsWith("http")
          ? item.poster_path
          : `https://image.tmdb.org/t/p/w500${item.poster_path}`,
        media_type: item.media_type || "movie",
      }));

    return NextResponse.json(
      { movies: movies.length > 0 ? movies : FALLBACK_MOVIES },
      { status: 200,headers:{'X-GTV-Metadata-Source':movies.length>0?'tmdb':'fallback','Cache-Control':'no-store'} }
    );
  } catch (error) {
    return NextResponse.json({ movies: FALLBACK_MOVIES }, { status: 200,headers:{'X-GTV-Metadata-Source':'fallback','X-GTV-Metadata-Failure':'network-or-response','Cache-Control':'no-store'} });
  }
}
